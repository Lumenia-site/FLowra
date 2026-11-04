import {
  MessageSquare,
  Play,
  Terminal,
  MousePointer2,
  Image,
  Video,
  Music2,
  Mic,
  File,
  MapPin,
  Contact,
  ListChecks,
  CircleHelp,
  Images,
  Pencil,
  Trash2,
  Rows3,
  Keyboard,
  ExternalLink,
  GitBranch,
  Split,
  Clock3,
  Shuffle,
  Variable,
  Save,
  FileInput,
  TextCursorInput,
  Globe,
} from "lucide-react";
import type { NodeKind, NodeData } from "../shared/types";

export const catalog: Record<
  NodeKind,
  {
    title: string;
    hint: string;
    group: string;
    icon: typeof Play;
    defaults: NodeData;
  }
> = {
  start: {
    title: "Начало",
    hint: "Команда /start",
    group: "События",
    icon: Play,
    defaults: { command: "/start" },
  },
  command: {
    title: "Команда",
    hint: "/help, /profile и другие",
    group: "События",
    icon: Terminal,
    defaults: { command: "/help" },
  },
  message: {
    title: "Сообщение пользователя",
    hint: "Любое входящее сообщение",
    group: "События",
    icon: MessageSquare,
    defaults: {},
  },
  callback: {
    title: "Нажатие кнопки",
    hint: "Входящий callback",
    group: "События",
    icon: MousePointer2,
    defaults: { callbackData: "action" },
  },
  sendMessage: {
    title: "Текстовое сообщение",
    hint: "Отправить текст",
    group: "Telegram",
    icon: MessageSquare,
    defaults: { text: "Привет, {{user.first_name}}!", parseMode: "" },
  },
  sendPhoto: {
    title: "Фотография",
    hint: "Файл, ссылка или file_id",
    group: "Медиа",
    icon: Image,
    defaults: { media: "", caption: "" },
  },
  sendVideo: {
    title: "Видео",
    hint: "Файл, ссылка или file_id",
    group: "Медиа",
    icon: Video,
    defaults: { media: "", caption: "" },
  },
  sendAudio: {
    title: "Аудио",
    hint: "Музыка или запись",
    group: "Медиа",
    icon: Music2,
    defaults: { media: "", caption: "" },
  },
  sendVoice: {
    title: "Голосовое сообщение",
    hint: "Запись голоса",
    group: "Медиа",
    icon: Mic,
    defaults: { media: "", caption: "" },
  },
  sendDocument: {
    title: "Документ",
    hint: "Отправить файл",
    group: "Медиа",
    icon: File,
    defaults: { media: "", caption: "" },
  },
  sendLocation: {
    title: "Геолокация",
    hint: "Точка на карте",
    group: "Telegram",
    icon: MapPin,
    defaults: { latitude: "41.3111", longitude: "69.2797" },
  },
  sendContact: {
    title: "Контакт",
    hint: "Имя и номер телефона",
    group: "Telegram",
    icon: Contact,
    defaults: { phoneNumber: "", firstName: "", lastName: "" },
  },
  sendPoll: {
    title: "Опрос",
    hint: "Собрать мнения",
    group: "Telegram",
    icon: ListChecks,
    defaults: {
      question: "",
      answers: ["Да", "Нет"],
      anonymous: true,
      multipleAnswers: false,
    },
  },
  sendQuiz: {
    title: "Викторина",
    hint: "Один правильный ответ",
    group: "Telegram",
    icon: CircleHelp,
    defaults: {
      question: "",
      answers: ["Первый ответ", "Второй ответ"],
      correctAnswer: 0,
      anonymous: true,
      explanation: "",
    },
  },
  sendMediaGroup: {
    title: "Альбом",
    hint: "2–10 фото и видео",
    group: "Медиа",
    icon: Images,
    defaults: {
      items: [
        { type: "photo", media: "", caption: "" },
        { type: "photo", media: "", caption: "" },
      ],
    },
  },
  editMessage: {
    title: "Изменить сообщение",
    hint: "Обновить отправленный текст",
    group: "Telegram",
    icon: Pencil,
    defaults: { text: "", messageId: "" },
  },
  deleteMessage: {
    title: "Удалить сообщение",
    hint: "По идентификатору",
    group: "Telegram",
    icon: Trash2,
    defaults: { messageId: "" },
  },
  inlineKeyboard: {
    title: "Инлайн-кнопки",
    hint: "Кнопки под сообщением",
    group: "Кнопки",
    icon: Rows3,
    defaults: {
      text: "Выберите действие",
      rows: [[{ text: "Продолжить", action: "callback", value: "continue" }]],
    },
  },
  replyKeyboard: {
    title: "Клавиатура",
    hint: "Текст, контакт или геопозиция",
    group: "Кнопки",
    icon: Keyboard,
    defaults: {
      text: "Выберите действие",
      rows: [[{ text: "Отправить контакт", action: "contact", value: "" }]],
    },
  },
  urlButton: {
    title: "Кнопка со ссылкой",
    hint: "Открыть страницу",
    group: "Кнопки",
    icon: ExternalLink,
    defaults: {
      text: "Полезная ссылка",
      buttonText: "Открыть",
      url: "https://telegram.org",
    },
  },
  condition: {
    title: "Условие",
    hint: "Да или нет",
    group: "Логика",
    icon: GitBranch,
    defaults: { variable: "name", operator: "exists", value: "" },
  },
  switch: {
    title: "Выбор ветки",
    hint: "Несколько вариантов",
    group: "Логика",
    icon: Split,
    defaults: {
      variable: "choice",
      cases: [
        { value: "1", handle: "1" },
        { value: "2", handle: "2" },
      ],
    },
  },
  delay: {
    title: "Пауза",
    hint: "Подождать перед действием",
    group: "Логика",
    icon: Clock3,
    defaults: { seconds: 1 },
  },
  random: {
    title: "Случайная ветка",
    hint: "Равновероятный переход",
    group: "Логика",
    icon: Shuffle,
    defaults: {},
  },
  variable: {
    title: "Переменная",
    hint: "Сохранить значение",
    group: "Данные",
    icon: Variable,
    defaults: { name: "name", value: "" },
  },
  setVariable: {
    title: "Записать переменную",
    hint: "Изменить значение",
    group: "Данные",
    icon: Save,
    defaults: { name: "name", value: "" },
  },
  getVariable: {
    title: "Прочитать переменную",
    hint: "Скопировать значение",
    group: "Данные",
    icon: FileInput,
    defaults: { name: "name", target: "result" },
  },
  input: {
    title: "Ответ пользователя",
    hint: "Дождаться следующего ответа",
    group: "Данные",
    icon: TextCursorInput,
    defaults: {
      variable: "answer",
      inputType: "text",
      prompt: "Как вас зовут?",
    },
  },
  http: {
    title: "HTTP-запрос",
    hint: "Обратиться к API",
    group: "Сеть",
    icon: Globe,
    defaults: {
      method: "GET",
      url: "",
      headers: {},
      query: {},
      body: "",
      responseVariable: "response",
    },
  },
};

export const operators = [
  ["equals", "Равно"],
  ["not equals", "Не равно"],
  ["contains", "Содержит"],
  ["greater", "Больше"],
  ["less", "Меньше"],
  ["greater or equal", "Больше или равно"],
  ["less or equal", "Меньше или равно"],
  ["exists", "Существует"],
];
export const groups = [
  "События",
  "Telegram",
  "Медиа",
  "Кнопки",
  "Логика",
  "Данные",
  "Сеть",
];
export function nodeSummary(type: NodeKind, data: NodeData): string {
  if (type === "start") return "/start";
  if (type === "command") return data.command || "Укажите команду";
  if (type === "message") return "Любое входящее сообщение";
  if (type === "callback") return data.callbackData || "Укажите callback";
  if (type === "condition")
    return `${data.variable || "Переменная"} ${operators.find((op) => op[0] === data.operator)?.[1]?.toLowerCase() || ""} ${data.value || ""}`;
  if (type === "delay") return `${data.seconds || 0} сек.`;
  if (type === "input")
    return data.prompt || `Сохранить в ${data.variable || "answer"}`;
  if (type === "variable" || type === "setVariable")
    return `${data.name || "name"} = ${data.value || "…"}`;
  if (type === "getVariable")
    return `${data.name || "name"} → ${data.target || "result"}`;
  if (type === "sendMediaGroup")
    return `${data.items?.length || 0} файлов в альбоме`;
  return String(
    data.text ||
      data.caption ||
      data.question ||
      data.media ||
      data.url ||
      data.variable ||
      catalog[type].hint,
  );
}
