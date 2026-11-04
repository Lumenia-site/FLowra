import type { NodeData, NodeKind } from '../../shared/types'
import { validateHttpUrl } from '../media'

function keyboardRows(data: NodeData, reply: boolean): any[][] {
  const rows = data.rows ?? []
  if (!Array.isArray(rows)) throw new Error('Клавиатура должна содержать строки кнопок.')
  return rows.map((row: any) => {
    const buttons = Array.isArray(row) ? row : row.buttons
    if (!Array.isArray(buttons) || !buttons.length) throw new Error('Строка клавиатуры пуста.')
    return buttons.map((button: any) => {
      const text = String(button.text ?? '').trim()
      if (!text) throw new Error('У кнопки должен быть текст.')
      const action = button.action ?? (reply ? 'text' : 'callback')
      const value = String(button.value ?? button.callbackData ?? '')
      if (reply) return { text, ...(action === 'contact' ? { request_contact: true } : {}), ...(action === 'location' ? { request_location: true } : {}) }
      if (action === 'url') return { text, url: validateHttpUrl(value).toString() }
      const callbackData = action === 'node' ? `__flowra:${value}` : value
      if (!callbackData || Buffer.byteLength(callbackData) > 64) throw new Error('Callback кнопки должен занимать от 1 до 64 байт.')
      return { text, callback_data: callbackData }
    })
  })
}

export function buildTelegramPayload(type: NodeKind, data: NodeData, context: Record<string, any>, chatId: number): { method: string; payload: Record<string, any> } {
  const payload: Record<string, any> = { chat_id: chatId }
  const mode = data.parseMode || undefined
  const caption = data.caption || undefined
  if (type === 'sendMessage') {
    if (!String(data.text ?? '').trim()) throw new Error('Сообщение не должно быть пустым.')
    return { method: 'sendMessage', payload: { ...payload, text: data.text, parse_mode: mode } }
  }
  const mediaFields: Record<string, string> = { sendPhoto: 'photo', sendVideo: 'video', sendAudio: 'audio', sendVoice: 'voice', sendDocument: 'document' }
  if (mediaFields[type]) {
    const media = data.media ?? data.file ?? data.url
    if (!media) throw new Error('Выберите файл, укажите URL или Telegram file_id.')
    if (String(media).startsWith('http')) validateHttpUrl(String(media))
    return { method: type, payload: { ...payload, [mediaFields[type]]: media, caption, parse_mode: mode } }
  }
  if (type === 'sendLocation') {
    const latitude = Number(data.latitude), longitude = Number(data.longitude)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error('Некорректные координаты: широта от −90 до 90, долгота от −180 до 180.')
    return { method: type, payload: { ...payload, latitude, longitude } }
  }
  if (type === 'sendContact') {
    if (!data.phoneNumber || !data.firstName) throw new Error('Укажите номер телефона и имя контакта.')
    return { method: type, payload: { ...payload, phone_number: data.phoneNumber, first_name: data.firstName, last_name: data.lastName || undefined } }
  }
  if (type === 'sendPoll' || type === 'sendQuiz') {
    const answers = data.answers ?? data.options
    if (!String(data.question ?? '').trim() || !Array.isArray(answers) || answers.length < 2 || answers.length > 12 || answers.some((answer: any) => !String(typeof answer === 'object' ? answer.text : answer).trim())) throw new Error('Для опроса нужны вопрос и от 2 до 12 непустых вариантов ответа.')
    const quiz = type === 'sendQuiz'
    const correct = Number(data.correctAnswer ?? 0)
    if (quiz && (!Number.isInteger(correct) || correct < 0 || correct >= answers.length)) throw new Error('Выберите правильный ответ викторины.')
    return { method: 'sendPoll', payload: { ...payload, question: data.question, options: answers.map((answer: any) => ({ text: typeof answer === 'object' ? answer.text : String(answer) })), type: quiz ? 'quiz' : 'regular', is_anonymous: data.anonymous !== false, allows_multiple_answers: quiz ? false : Boolean(data.multiple ?? data.multipleAnswers), ...(quiz ? { correct_option_ids: [correct], explanation: data.explanation || undefined } : {}) } }
  }
  if (type === 'sendMediaGroup') {
    const items = data.items ?? data.media
    if (!Array.isArray(items) || items.length < 2 || items.length > 10) throw new Error('Альбом должен содержать от 2 до 10 фото или видео.')
    const media = items.map((item: any) => {
      if (!['photo', 'video'].includes(item.type) || !item.media) throw new Error('В альбоме допускаются только фото и видео с выбранным источником.')
      if (String(item.media).startsWith('http')) validateHttpUrl(item.media)
      return { type: item.type, media: item.media, caption: item.caption || undefined, parse_mode: mode }
    })
    return { method: type, payload: { ...payload, media } }
  }
  if (type === 'editMessage' || type === 'deleteMessage') {
    const messageId = Number(data.messageId || context.last_message_id || context.message?.message_id)
    if (!Number.isInteger(messageId) || messageId <= 0) throw new Error('Для изменения или удаления нужен ID сообщения.')
    return { method: type === 'editMessage' ? 'editMessageText' : 'deleteMessage', payload: { ...payload, message_id: messageId, ...(type === 'editMessage' ? { text: data.text, parse_mode: mode } : {}) } }
  }
  if (type === 'inlineKeyboard' || type === 'replyKeyboard') {
    const reply = type === 'replyKeyboard'
    const rows = keyboardRows(data, reply)
    if (!rows.length) throw new Error('Добавьте хотя бы одну кнопку.')
    const markup = reply ? { keyboard: rows, resize_keyboard: true, one_time_keyboard: Boolean(data.oneTime) } : { inline_keyboard: rows }
    if (!reply && !data.text && context.last_message_id) return { method: 'editMessageReplyMarkup', payload: { ...payload, message_id: context.last_message_id, reply_markup: markup } }
    return { method: 'sendMessage', payload: { ...payload, text: data.text || 'Выберите действие:', parse_mode: mode, reply_markup: markup } }
  }
  if (type === 'urlButton') return { method: 'sendMessage', payload: { ...payload, text: data.text || 'Открыть ссылку:', parse_mode: mode, reply_markup: { inline_keyboard: [[{ text: data.buttonText || 'Открыть', url: validateHttpUrl(data.url).toString() }]] } } }
  throw new Error(`Блок ${type} не является действием Telegram.`)
}
