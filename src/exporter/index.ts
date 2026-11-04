import { readFile, writeFile, mkdir, realpath, readdir } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { referencedAssets, validateWorkflow } from '../shared/workflow'
import type { Project } from '../shared/types'

export interface ExportOptions {
  project: Project
  projectRoot: string
  outputPath: string
  language: 'javascript' | 'python'
  resourcesRoot?: string
}

export async function exportProject({ project, projectRoot, outputPath, language, resourcesRoot = resolve('resources') }: ExportOptions): Promise<void> {
  validateWorkflow(project.workflow)
  if (!['javascript', 'python'].includes(language)) throw new Error('Выберите JavaScript или Python.')
  const files: Record<string, Uint8Array> = {}
  const folder = project.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'flowra-bot'
  const put = (name: string, text: string) => { files[`${folder}/${name}`] = strToU8(text) }
  put('workflow.json', JSON.stringify(project.workflow, null, 2))
  put('.env.example', 'TELEGRAM_BOT_TOKEN=\n')
  put('.gitignore', '.env\n*.db\n*.db-*\nnode_modules/\n__pycache__/\n.venv/\n')
  const root = resolve(projectRoot)
  for (const relative of referencedAssets(project.workflow)) {
    const full = resolve(root, relative)
    if (!full.startsWith(`${root}${sep}`)) throw new Error('Некорректный путь к медиафайлу.')
    try {
      const assetsRoot = await realpath(resolve(root, 'assets'))
      const actual = await realpath(full)
      if (!actual.startsWith(`${assetsRoot}${sep}`)) throw new Error('Файл находится за пределами assets проекта.')
      files[`${folder}/${relative}`] = await readFile(actual)
    }
    catch { throw new Error(`Не удалось прочитать медиафайл «${basename(relative)}». Выберите его заново перед экспортом.`) }
  }
  if (language === 'javascript') {
    put('index.js', "require('./runtime.cjs')\n")
    put('package.json', JSON.stringify({ name: 'flowra-bot', version: '1.0.0', private: true, license: 'GPL-3.0-or-later', scripts: { start: 'node index.js' }, engines: { node: '>=22.18.0' } }, null, 2))
    files[`${folder}/runtime.cjs`] = await readFile(resolve(resourcesRoot, 'javascript/runtime.cjs'))
    const sourceRoot = resolve(resourcesRoot, 'javascript/source')
    const addSource = async (relative: string) => {
      const entries = await readdir(resolve(sourceRoot, relative), { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || !/^[a-zA-Z0-9._-]+$/.test(entry.name)) throw new Error('В исходниках runtime обнаружен небезопасный путь.')
        const name = `${relative}/${entry.name}`
        if (entry.isDirectory()) await addSource(name)
        else if (entry.isFile() && entry.name.endsWith('.ts')) files[`${folder}/source/${name}`] = await readFile(resolve(sourceRoot, name))
      }
    }
    await addSource('src')
    put('source/package.json', JSON.stringify({ name: 'flowra-bot-source', version: '1.0.0', private: true, type: 'module', license: 'GPL-3.0-or-later', scripts: { build: 'node build.mjs' }, engines: { node: '>=22.18.0' }, devDependencies: { esbuild: '^0.27.0' } }, null, 2))
    put('source/build.mjs', "import { build } from 'esbuild'\nimport { fileURLToPath } from 'node:url'\nimport { resolve } from 'node:path'\n\nconst root = fileURLToPath(new URL('.', import.meta.url))\nawait build({ absWorkingDir: root, entryPoints: ['src/exporter/javascript/entry.ts'], outfile: resolve(root, '../runtime.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs' })\n")
  } else {
    for (const name of ['index.py', 'api.py', 'engine.py', 'storage.py']) files[`${folder}/${name}`] = await readFile(resolve(resourcesRoot, 'python', name))
    put('requirements.txt', '')
  }
  files[`${folder}/LICENSE`] = await readFile(resolve(resourcesRoot, 'LICENSE'))
  put('README.md', exportReadme(project.name, language))
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, zipSync(files, { level: 6 }))
}

function exportReadme(name: string, language: 'javascript' | 'python'): string {
  const javascript = language === 'javascript'
  return `# ${name.replace(/[\r\n]/g, ' ')}

Telegram-бот, собранный в Flowra. Сценарий находится в workflow.json, локальные медиа — в assets/.

## Запуск

${javascript ? 'Установите Node.js 22.18 или новее.' : 'Установите Python 3.11 или новее. Используется стандартная библиотека Python.'}

1. Распакуйте весь архив в отдельную папку.
2. Скопируйте .env.example в .env.
3. Откройте .env текстовым редактором и укажите токен, полученный у @BotFather:

\`\`\`text
TELEGRAM_BOT_TOKEN=ваш_токен
\`\`\`

4. В терминале в папке проекта выполните:

\`\`\`sh
${javascript ? 'npm install\nnpm start' : 'pip install -r requirements.txt\npython index.py'}
\`\`\`

Для остановки нажмите Ctrl+C. Пока бот работает здесь, остановите его в Flowra и на других компьютерах: Telegram разрешает только один процесс получения обновлений для одного токена.

## Данные

При первом запуске создаётся bot.db (SQLite). Здесь сохраняются пользователи, их переменные, ожидаемый ввод и позиция получения обновлений. Существующие пользователи из Flowra в архив не включены. Токен в архиве отсутствует; не публикуйте .env и bot.db.

Пользователи обрабатываются параллельно, сообщения одного пользователя — по порядку. Ожидание ответа сохраняется между запусками. Выполняющиеся паузы, HTTP-запросы и действия в очереди после остановки не продолжаются: при необходимости повторите /start. Telegram Bot API не гарантирует однократную отправку при обрыве соединения в момент доставки.

Пути к медиа вычисляются относительно папки программы. Программу можно запускать из другой рабочей папки. Чтобы перенести бот с сохранением данных, остановите его и скопируйте всю папку вместе с bot.db.

## Сценарий

Сохранены все блоки workflow, включая условия, переменные, ввод, кнопки, запросы HTTP, опросы, викторины и альбомы. Переменные подставляются как {{user.first_name}}, {{chat.id}} и {{name}}. Пользовательские данные разделены по Telegram-пользователям. Перед публикацией проверьте ветки сценария со своим тестовым аккаунтом.

Панель управления Flowra и её рассылки в самостоятельный бот не входят. Отправляйте рассылки из desktop-приложения; у экспортированного бота собственная база пользователей.

${javascript ? `## Изменение и пересборка runtime

Предпочтительные для редактирования исходники TypeScript находятся в source/src/. Здесь есть обработчики всех блоков, Telegram-клиент, описание workflow и точка запуска с SQLite. Файл runtime.cjs собран из этих исходников.

После изменения исходников выполните из папки бота:

\`\`\`sh
cd source
npm install
npm run build
cd ..
npm start
\`\`\`

Скрипт source/build.mjs заменяет runtime.cjs в корне проекта. Для обычного запуска пересборка не нужна. При распространении бота сохраняйте исходники source/ и LICENSE.

` : ''}## Если бот не отвечает

- Проверьте токен и доступ к api.telegram.org.
- При ошибке 409 остановите другой запущенный экземпляр бота и отключите webhook.
- При ошибке 401 получите новый токен у @BotFather и обновите .env.
- Проверьте, что блок /start связан с первым действием.
- Сохраняйте папку assets вместе с программой.

Лицензия: GNU GPL v3 или более поздняя версия (GPL-3.0-or-later). Полный текст — LICENSE.
`
}
