import { useEffect, useState } from "react";
import { Copy, FileUp, Plus, Trash2, X } from "lucide-react";
import type { FlowNode, NodeData, NodeKind, Asset } from "../shared/types";
import { catalog, operators } from "./catalog";
import { Field, IconButton, formatSize } from "./ui";

function TextField({
  label,
  value,
  onChange,
  multiline = false,
  hint,
  type = "text",
}: {
  label: string;
  value: any;
  onChange: (value: string) => void;
  multiline?: boolean;
  hint?: string;
  type?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      {multiline ? (
        <textarea
          rows={4}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type={type}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

function JsonField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: any;
  onChange: (value: any) => void;
  hint?: string;
}) {
  const [text, setText] = useState(JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState("");
  useEffect(() => {
    setText(
      typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2),
    );
  }, [value]);
  return (
    <Field label={label} hint={error || hint}>
      <textarea
        className={`code-input ${error ? "invalid" : ""}`}
        rows={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError("");
        }}
        onBlur={() => {
          try {
            const parsed = JSON.parse(text || "{}");
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              throw new Error();
            onChange(parsed);
          } catch {
            setError(
              'Нужен корректный JSON-объект, например {"key": "value"}.',
            );
          }
        }}
      />
    </Field>
  );
}

export function MediaField({
  projectId,
  kind,
  value,
  onChange,
  onError,
  label = "Файл или ссылка",
}: {
  projectId: string;
  kind: NodeKind;
  value: string;
  onChange: (value: string) => void;
  onError: (text: string) => void;
  label?: string;
}) {
  const [asset, setAsset] = useState<Asset | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setAsset(undefined);
    if (value?.startsWith("assets/"))
      window.flowra
        .listAssets(projectId)
        .then((list) => {
          if (active) setAsset(list.find((item) => item.path === value));
        })
        .catch((error) => onError(String(error.message || error)));
    return () => {
      active = false;
    };
  }, [projectId, value]);
  async function pick() {
    setBusy(true);
    try {
      const file = await window.flowra.pickAsset({ projectId, kind });
      if (file) {
        setAsset(file);
        onChange(file.path);
      }
    } catch (error: any) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="media-field">
      <TextField
        label={label}
        value={value}
        onChange={onChange}
        hint="Локальный файл, https:// или Telegram file_id"
      />
      {asset && (
        <div className="asset-info">
          {asset.preview && asset.mime.startsWith("image/") && (
            <img src={asset.preview} alt={asset.name} />
          )}
          <div>
            <strong>{asset.name}</strong>
            <small>
              {asset.mime} · {formatSize(asset.size)}
            </small>
          </div>
        </div>
      )}
      <div className="button-row">
        <button
          className="button secondary small"
          onClick={pick}
          disabled={busy}
        >
          <FileUp size={14} />
          {busy ? "Копирование…" : value ? "Заменить файл" : "Выбрать файл"}
        </button>
        {value && (
          <IconButton title="Убрать файл из блока" onClick={() => onChange("")}>
            <X size={15} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

export default function Properties({
  node,
  projectId,
  nodes,
  onChange,
  onDelete,
  onDuplicate,
  onError,
}: {
  node?: FlowNode;
  projectId: string;
  nodes: FlowNode[];
  onChange: (data: NodeData) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onError: (text: string) => void;
}) {
  if (!node)
    return (
      <aside className="properties">
        <div className="panel-title">Свойства блока</div>
        <div className="property-empty">
          <MousePointer />
          <h3>Выберите блок</h3>
          <p>
            Здесь появятся его настройки. Добавьте блок слева или нажмите на
            него на схеме.
          </p>
          <kbd>Delete</kbd>
          <span>удалить выбранное</span>
          <kbd>Ctrl D</kbd>
          <span>дублировать блоки</span>
          <kbd>Ctrl Z</kbd>
          <span>отменить изменение</span>
        </div>
      </aside>
    );
  const data = node.data;
  const set = (key: string, value: any) => onChange({ ...data, [key]: value });
  const text = (
    key: string,
    label: string,
    hint?: string,
    multiline = false,
    type = "text",
  ) => (
    <TextField
      key={key}
      label={label}
      value={data[key]}
      onChange={(value) => set(key, value)}
      hint={hint}
      multiline={multiline}
      type={type}
    />
  );
  const select = (key: string, label: string, options: string[][]) => (
    <Field key={key} label={label}>
      <select
        value={data[key] ?? ""}
        onChange={(e) => set(key, e.target.value)}
      >
        {options.map(([value, title]) => (
          <option key={value} value={value}>
            {title}
          </option>
        ))}
      </select>
    </Field>
  );
  const check = (key: string, label: string) => (
    <label className="checkbox-field" key={key}>
      <input
        type="checkbox"
        checked={Boolean(data[key])}
        onChange={(e) => set(key, e.target.checked)}
      />
      {label}
    </label>
  );
  const format = select("parseMode", "Формат текста", [
    ["", "Обычный текст"],
    ["HTML", "HTML"],
    ["MarkdownV2", "MarkdownV2"],
  ]);
  const Icon = catalog[node.type].icon;
  const mediaTypes: NodeKind[] = [
    "sendPhoto",
    "sendVideo",
    "sendAudio",
    "sendVoice",
    "sendDocument",
  ];
  return (
    <aside className="properties">
      <div className="panel-title">
        Свойства блока
        <IconButton title="Дублировать блок" onClick={onDuplicate}>
          <Copy size={14} />
        </IconButton>
      </div>
      <div className="property-scroll" key={node.id}>
        <div className="property-type">
          <span className="block-icon">
            <Icon size={19} />
          </span>
          <div>
            <strong>{catalog[node.type].title}</strong>
            <small>{node.id}</small>
          </div>
        </div>
        {text("label", "Название блока")}
        {node.type === "start" && (
          <Field label="Команда">
            <input value="/start" readOnly />
          </Field>
        )}
        {node.type === "command" &&
          text("command", "Команда", "Начинается с /, например /help")}
        {node.type === "callback" &&
          text(
            "callbackData",
            "Значение callback",
            "Совпадает со значением инлайн-кнопки",
          )}
        {[
          "sendMessage",
          "editMessage",
          "inlineKeyboard",
          "replyKeyboard",
          "urlButton",
        ].includes(node.type) && (
          <>
            {text(
              "text",
              "Текст сообщения",
              "Переменные: {{user.first_name}}, {{name}}",
              true,
            )}
            {format}
          </>
        )}
        {["editMessage", "deleteMessage"].includes(node.type) &&
          text(
            "messageId",
            "ID сообщения",
            "Оставьте пустым, чтобы использовать последнее сообщение",
          )}
        {mediaTypes.includes(node.type) && (
          <>
            <MediaField
              projectId={projectId}
              kind={node.type}
              value={data.media || ""}
              onChange={(value) => set("media", value)}
              onError={onError}
            />
            {text("caption", "Подпись", undefined, true)}
            {format}
          </>
        )}
        {node.type === "sendLocation" && (
          <>
            {text("latitude", "Широта", "Число или {{location.latitude}}")}
            {text("longitude", "Долгота", "Число или {{location.longitude}}")}
          </>
        )}
        {node.type === "sendContact" && (
          <>
            {text("phoneNumber", "Номер телефона")}
            {text("firstName", "Имя")}
            {text("lastName", "Фамилия")}
          </>
        )}
        {["sendPoll", "sendQuiz"].includes(node.type) && (
          <>
            {text("question", "Вопрос", undefined, true)}
            <div className="field">
              <span>Варианты ответа</span>
              <div className="array-list">
                {(data.answers || []).map((answer: string, index: number) => (
                  <div className="inline-input" key={index}>
                    {node.type === "sendQuiz" && (
                      <input
                        type="radio"
                        aria-label={`Правильный ответ ${index + 1}`}
                        name={`correct-${node.id}`}
                        checked={Number(data.correctAnswer) === index}
                        onChange={() => set("correctAnswer", index)}
                      />
                    )}
                    <input
                      aria-label={`Ответ ${index + 1}`}
                      value={answer}
                      onChange={(e) =>
                        set(
                          "answers",
                          data.answers.map((item: string, i: number) =>
                            i === index ? e.target.value : item,
                          ),
                        )
                      }
                    />
                    <IconButton
                      title="Удалить ответ"
                      disabled={data.answers.length <= 2}
                      onClick={() =>
                        onChange({
                          ...data,
                          answers: data.answers.filter(
                            (_: any, i: number) => i !== index,
                          ),
                          correctAnswer: 0,
                        })
                      }
                    >
                      <X size={14} />
                    </IconButton>
                  </div>
                ))}
              </div>
              <button
                className="text-button"
                disabled={data.answers?.length >= 12}
                onClick={() => set("answers", [...(data.answers || []), ""])}
              >
                <Plus size={14} />
                Добавить ответ
              </button>
              {node.type === "sendQuiz" && (
                <small>Отметьте кружком правильный ответ.</small>
              )}
            </div>
            {check("anonymous", "Анонимный опрос")}
            {node.type === "sendPoll"
              ? check("multipleAnswers", "Можно выбрать несколько ответов")
              : text("explanation", "Объяснение ответа", undefined, true)}
          </>
        )}
        {node.type === "sendMediaGroup" && (
          <div className="field">
            <span>Файлы альбома</span>
            {(data.items || []).map((item: any, index: number) => (
              <div className="array-card" key={index}>
                <div className="array-heading">
                  <span>Файл {index + 1}</span>
                  <IconButton
                    title="Убрать из альбома"
                    onClick={() =>
                      set(
                        "items",
                        data.items.filter((_: any, i: number) => i !== index),
                      )
                    }
                  >
                    <X size={14} />
                  </IconButton>
                </div>
                <select
                  aria-label="Тип медиа"
                  value={item.type}
                  onChange={(e) =>
                    set(
                      "items",
                      data.items.map((a: any, i: number) =>
                        i === index ? { ...a, type: e.target.value } : a,
                      ),
                    )
                  }
                >
                  <option value="photo">Фотография</option>
                  <option value="video">Видео</option>
                </select>
                <MediaField
                  projectId={projectId}
                  kind={item.type === "video" ? "sendVideo" : "sendPhoto"}
                  value={item.media}
                  onChange={(value) =>
                    set(
                      "items",
                      data.items.map((a: any, i: number) =>
                        i === index ? { ...a, media: value } : a,
                      ),
                    )
                  }
                  onError={onError}
                />
                <input
                  aria-label="Подпись к файлу"
                  placeholder="Подпись"
                  value={item.caption || ""}
                  onChange={(e) =>
                    set(
                      "items",
                      data.items.map((a: any, i: number) =>
                        i === index ? { ...a, caption: e.target.value } : a,
                      ),
                    )
                  }
                />
              </div>
            ))}
            <button
              className="text-button"
              disabled={data.items?.length >= 10}
              onClick={() =>
                set("items", [
                  ...(data.items || []),
                  { type: "photo", media: "", caption: "" },
                ])
              }
            >
              <Plus size={14} />
              Добавить файл
            </button>
            <small>Telegram отправит 2–10 файлов одним альбомом.</small>
          </div>
        )}
        {["inlineKeyboard", "replyKeyboard"].includes(node.type) && (
          <div className="field">
            <span>Кнопки</span>
            {(data.rows || []).map((row: any[], rowIndex: number) => (
              <div className="array-card" key={rowIndex}>
                <div className="array-heading">
                  <span>Ряд {rowIndex + 1}</span>
                  <IconButton
                    title="Удалить ряд"
                    onClick={() =>
                      set(
                        "rows",
                        data.rows.filter((_: any, i: number) => i !== rowIndex),
                      )
                    }
                  >
                    <X size={14} />
                  </IconButton>
                </div>
                {row.map((button: any, buttonIndex: number) => {
                  const update = (key: string, value: string) =>
                    set(
                      "rows",
                      data.rows.map((r: any[], ri: number) =>
                        ri === rowIndex
                          ? r.map((b: any, bi: number) =>
                              bi === buttonIndex ? { ...b, [key]: value } : b,
                            )
                          : r,
                      ),
                    );
                  return (
                    <div className="keyboard-button" key={buttonIndex}>
                      <div className="inline-input">
                        <input
                          aria-label="Надпись кнопки"
                          placeholder="Надпись"
                          value={button.text}
                          onChange={(e) => update("text", e.target.value)}
                        />
                        <IconButton
                          title="Удалить кнопку"
                          onClick={() =>
                            set(
                              "rows",
                              data.rows.map((r: any[], ri: number) =>
                                ri === rowIndex
                                  ? r.filter(
                                      (_: any, bi: number) =>
                                        bi !== buttonIndex,
                                    )
                                  : r,
                              ),
                            )
                          }
                        >
                          <X size={13} />
                        </IconButton>
                      </div>
                      <select
                        aria-label="Действие кнопки"
                        value={button.action}
                        onChange={(e) => update("action", e.target.value)}
                      >
                        {(node.type === "inlineKeyboard"
                          ? [
                              ["callback", "Callback"],
                              ["url", "Открыть ссылку"],
                              ["node", "Перейти к блоку"],
                            ]
                          : [
                              ["text", "Отправить текст"],
                              ["contact", "Запросить контакт"],
                              ["location", "Запросить геопозицию"],
                            ]
                        ).map(([value, title]) => (
                          <option key={value} value={value}>
                            {title}
                          </option>
                        ))}
                      </select>
                      {["callback", "url"].includes(button.action) && (
                        <input
                          aria-label="Значение кнопки"
                          placeholder={
                            button.action === "url"
                              ? "https://"
                              : "callback_data"
                          }
                          value={button.value}
                          onChange={(e) => update("value", e.target.value)}
                        />
                      )}
                      {button.action === "node" && (
                        <select
                          aria-label="Блок для перехода"
                          value={button.value}
                          onChange={(e) => update("value", e.target.value)}
                        >
                          <option value="">Выберите блок</option>
                          {nodes
                            .filter((n) => n.id !== node.id)
                            .map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.data.label || catalog[n.type].title}
                              </option>
                            ))}
                        </select>
                      )}
                    </div>
                  );
                })}
                <button
                  className="text-button"
                  onClick={() =>
                    set(
                      "rows",
                      data.rows.map((r: any[], ri: number) =>
                        ri === rowIndex
                          ? [
                              ...r,
                              {
                                text: "Кнопка",
                                action:
                                  node.type === "inlineKeyboard"
                                    ? "callback"
                                    : "text",
                                value: "",
                              },
                            ]
                          : r,
                      ),
                    )
                  }
                >
                  <Plus size={13} />
                  Кнопка в этот ряд
                </button>
              </div>
            ))}
            <button
              className="text-button"
              onClick={() =>
                set("rows", [
                  ...(data.rows || []),
                  [
                    {
                      text: "Кнопка",
                      action:
                        node.type === "inlineKeyboard" ? "callback" : "text",
                      value: "",
                    },
                  ],
                ])
              }
            >
              <Plus size={14} />
              Добавить ряд
            </button>
          </div>
        )}
        {node.type === "urlButton" && (
          <>
            {text("buttonText", "Надпись кнопки")}
            {text("url", "Ссылка")}
          </>
        )}
        {["condition", "switch"].includes(node.type) &&
          text(
            "variable",
            "Переменная",
            "Например name или user.language_code",
          )}
        {node.type === "condition" && (
          <>
            {select("operator", "Сравнение", operators)}
            {data.operator !== "exists" &&
              text("value", "Значение для сравнения")}
          </>
        )}
        {node.type === "switch" && (
          <div className="field">
            <span>Ветки</span>
            {(data.cases || []).map((item: any, index: number) => (
              <div className="array-card" key={index}>
                <div className="inline-input">
                  <input
                    aria-label="Значение ветки"
                    placeholder="Значение"
                    value={item.value}
                    onChange={(e) =>
                      set(
                        "cases",
                        data.cases.map((c: any, i: number) =>
                          i === index ? { ...c, value: e.target.value } : c,
                        ),
                      )
                    }
                  />
                  <IconButton
                    title="Удалить ветку"
                    onClick={() =>
                      set(
                        "cases",
                        data.cases.filter((_: any, i: number) => i !== index),
                      )
                    }
                  >
                    <X size={14} />
                  </IconButton>
                </div>
                <small>Выход: {item.handle}</small>
              </div>
            ))}
            <button
              className="text-button"
              onClick={() =>
                set("cases", [
                  ...(data.cases || []),
                  { value: "", handle: crypto.randomUUID().slice(0, 6) },
                ])
              }
            >
              <Plus size={14} />
              Добавить ветку
            </button>
            <small>
              Выход «Иначе» используется, когда ни одно значение не подошло.
            </small>
          </div>
        )}
        {node.type === "random" && (
          <p className="field-note">
            Подключите несколько блоков к выходу. При запуске бот выберет один
            из них случайно.
          </p>
        )}
        {node.type === "delay" &&
          text(
            "seconds",
            "Задержка, секунды",
            "От 0 до 86 400 секунд",
            false,
            "number",
          )}
        {["variable", "setVariable", "getVariable"].includes(node.type) &&
          text("name", "Имя переменной")}
        {["variable", "setVariable"].includes(node.type) &&
          text(
            "value",
            "Значение",
            "Строка, число или {{другая_переменная}}",
            true,
          )}
        {node.type === "getVariable" &&
          text("target", "Сохранить копию в переменную")}
        {node.type === "input" && (
          <>
            {text("prompt", "Вопрос пользователю", undefined, true)}
            {select("inputType", "Тип ответа", [
              ["text", "Текст"],
              ["number", "Число"],
              ["contact", "Контакт"],
              ["location", "Геопозиция"],
            ])}
            {text(
              "variable",
              "Сохранить ответ в переменную",
              "Значение сохраняется отдельно для каждого пользователя",
            )}
          </>
        )}
        {node.type === "http" && (
          <>
            {select(
              "method",
              "Метод",
              ["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => [
                value,
                value,
              ]),
            )}
            {text(
              "url",
              "URL",
              "http:// или https://; переменные поддерживаются",
            )}
            <JsonField
              label="Заголовки"
              value={data.headers}
              onChange={(value) => set("headers", value)}
              hint='Например {"Accept": "application/json"}'
            />
            <JsonField
              label="Параметры запроса"
              value={data.query}
              onChange={(value) => set("query", value)}
            />
            {text(
              "body",
              "Тело запроса",
              "JSON или текст, можно использовать переменные",
              true,
            )}
            {text("responseVariable", "Переменная с ответом")}
          </>
        )}
        <div className="property-footer">
          <button className="text-button danger" onClick={onDelete}>
            <Trash2 size={14} />
            Удалить блок
          </button>
          <p>Изменения сохраняются автоматически.</p>
        </div>
      </div>
    </aside>
  );
}

function MousePointer() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="m4 3 7 17 2-7 7-2L4 3Z" />
    </svg>
  );
}
