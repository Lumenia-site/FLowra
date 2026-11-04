import { useEffect, useState } from "react";
import {
  Users,
  Download,
  Search,
  SlidersHorizontal,
  Trash2,
  Send,
  Square,
  CircleCheck,
  AlertTriangle,
  Terminal,
  Copy,
  RefreshCw,
  FolderOpen,
} from "lucide-react";
import type {
  BotUser,
  UserFilter,
  Project,
  Broadcast,
  BroadcastContent,
  LogEntry,
  Asset,
} from "../shared/types";
import {
  Empty,
  Field,
  IconButton,
  Modal,
  Busy,
  formatDate,
  formatSize,
} from "./ui";
import { operators } from "./catalog";
import { MediaField } from "./Properties";

export function FilterFields({
  value,
  onChange,
  compact = false,
}: {
  value: UserFilter;
  onChange: (value: UserFilter) => void;
  compact?: boolean;
}) {
  const set = (key: keyof UserFilter, next: any) =>
    onChange({ ...value, [key]: next || undefined });
  return (
    <div className={`filters ${compact ? "compact" : ""}`}>
      <Field label="Поиск">
        <div className="search">
          <Search size={15} />
          <input
            aria-label="Поиск пользователей"
            placeholder="Имя, username или ID"
            value={value.search || ""}
            onChange={(e) => set("search", e.target.value)}
          />
        </div>
      </Field>
      <Field label="Язык Telegram">
        <input
          placeholder="Например ru"
          value={value.languageCode || ""}
          onChange={(e) => set("languageCode", e.target.value)}
        />
      </Field>
      <Field label="Был активен">
        <select
          value={value.activeDays || ""}
          onChange={(e) => set("activeDays", Number(e.target.value))}
        >
          <option value="">За всё время</option>
          <option value="1">За последние сутки</option>
          <option value="7">За неделю</option>
          <option value="30">За месяц</option>
        </select>
      </Field>
      <Field label="Переменная">
        <input
          placeholder="Имя переменной"
          value={value.variable || ""}
          onChange={(e) => set("variable", e.target.value)}
        />
      </Field>
      {value.variable && (
        <>
          <Field label="Сравнение">
            <select
              value={value.operator || "equals"}
              onChange={(e) => set("operator", e.target.value)}
            >
              {operators.map(([key, title]) => (
                <option value={key} key={key}>
                  {title}
                </option>
              ))}
            </select>
          </Field>
          {value.operator !== "exists" && (
            <Field label="Значение">
              <input
                placeholder="Значение переменной"
                value={value.value || ""}
                onChange={(e) => set("value", e.target.value)}
              />
            </Field>
          )}
        </>
      )}
      <Field label="Доступность">
        <select
          value={value.blocked === undefined ? "" : String(value.blocked)}
          onChange={(e) =>
            onChange({
              ...value,
              blocked:
                e.target.value === "" ? undefined : e.target.value === "true",
            })
          }
        >
          <option value="">Все пользователи</option>
          <option value="false">Бот доступен</option>
          <option value="true">Заблокировали бота</option>
        </select>
      </Field>
      <Field label="Username">
        <select
          value={value.username || ""}
          onChange={(e) => set("username", e.target.value)}
        >
          <option value="">Любой</option>
          <option value="exists">Указан</option>
          <option value="missing">Не указан</option>
        </select>
      </Field>
      <Field label="Первое обращение с">
        <input
          type="date"
          value={value.firstStartedAfter?.slice(0, 10) || ""}
          onChange={(e) => set("firstStartedAfter", e.target.value)}
        />
      </Field>
      <Field label="Активность с">
        <input
          type="date"
          value={value.lastActivityAfter?.slice(0, 10) || ""}
          onChange={(e) => set("lastActivityAfter", e.target.value)}
        />
      </Field>
    </div>
  );
}

export function UsersPage({
  project,
  onError,
  onNotice,
}: {
  project: Project;
  onError: (text: string) => void;
  onNotice: (text: string) => void;
}) {
  const [users, setUsers] = useState<BotUser[]>([]);
  const [filters, setFilters] = useState<UserFilter>({});
  const [showFilters, setShowFilters] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<BotUser | null>(null);
  const [variables, setVariables] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sort, setSort] = useState("activity");
  const [descending, setDescending] = useState(true);
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(users.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const sorted = [...users].sort((left, right) => {
    const compared =
      sort === "name"
        ? `${left.firstName} ${left.lastName || ""}`.localeCompare(
            `${right.firstName} ${right.lastName || ""}`,
            "ru",
          )
        : sort === "messages"
          ? left.messageCount - right.messageCount
          : left.lastActivityAt.localeCompare(right.lastActivityAt);
    return descending ? -compared : compared;
  });
  const shown = sorted.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  useEffect(() => setPage(1), [JSON.stringify(filters)]);
  async function load() {
    try {
      setUsers(
        await window.flowra.listUsers({ projectId: project.id, filters }),
      );
    } catch (error: any) {
      onError(error.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [project.id, JSON.stringify(filters)]);
  useEffect(
    () =>
      window.flowra.onEvent((event) => {
        if (event.projectId === project.id && event.type === "users") load();
      }),
    [project.id, JSON.stringify(filters)],
  );
  async function saveVariables() {
    if (!selected) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(variables);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Переменные должны быть JSON-объектом.");
      await window.flowra.setUserVariables({
        projectId: project.id,
        userId: selected.id,
        variables: parsed,
      });
      await load();
      setSelected(null);
      onNotice("Переменные сохранены.");
    } catch (error: any) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="management-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Аудитория бота</span>
          <h1>
            Пользователи <span className="heading-count">{users.length}</span>
          </h1>
          <p>
            Все, кто взаимодействовал с вашим ботом. Данные хранятся на этом
            компьютере.
          </p>
        </div>
        <div className="button-row">
          <button
            className={`button secondary ${showFilters ? "active" : ""}`}
            onClick={() => setShowFilters(!showFilters)}
          >
            <SlidersHorizontal size={16} />
            Фильтры
          </button>
          <button
            className="button secondary"
            onClick={async () => {
              try {
                const path = await window.flowra.exportUsers({
                  projectId: project.id,
                  filters,
                });
                if (path) onNotice(`Таблица сохранена: ${path}`);
              } catch (error: any) {
                onError(error.message);
              }
            }}
            disabled={!users.length}
          >
            <Download size={16} />
            Скачать CSV
          </button>
        </div>
      </div>
      {showFilters && (
        <div className="filter-panel">
          <FilterFields value={filters} onChange={setFilters} />
          <button className="text-button" onClick={() => setFilters({})}>
            Сбросить фильтры
          </button>
        </div>
      )}
      {users.length > 0 && (
        <div className="user-table-tools">
          <span>{users.length} пользователей по выбранным условиям</span>
          <div>
            <label>
              Сортировать{" "}
              <select
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value);
                  setPage(1);
                }}
              >
                <option value="activity">По активности</option>
                <option value="name">По имени</option>
                <option value="messages">По числу сообщений</option>
              </select>
            </label>
            <button
              className="text-button"
              onClick={() => setDescending((value) => !value)}
            >
              {descending ? "↓ По убыванию" : "↑ По возрастанию"}
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <Busy />
      ) : users.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Пользователь</th>
                <th>Telegram ID</th>
                <th>Язык</th>
                <th>Сообщения</th>
                <th>Последняя активность</th>
                <th>Переменные</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((user) => (
                <tr
                  key={user.id}
                  onClick={() => {
                    setSelected(user);
                    setVariables(JSON.stringify(user.variables, null, 2));
                  }}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      setSelected(user);
                      setVariables(JSON.stringify(user.variables, null, 2));
                    }
                  }}
                >
                  <td>
                    <div className="table-person">
                      <span className="avatar">
                        {user.firstName?.slice(0, 1).toUpperCase() || "?"}
                      </span>
                      <div>
                        <strong>
                          {[user.firstName, user.lastName]
                            .filter(Boolean)
                            .join(" ") || "Без имени"}
                        </strong>
                        <small>
                          {user.username ? `@${user.username}` : "Без username"}
                          {user.blocked ? " · Бот заблокирован" : ""}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td className="mono muted">{user.telegramUserId}</td>
                  <td>{user.languageCode || "—"}</td>
                  <td>{user.messageCount}</td>
                  <td>{formatDate(user.lastActivityAt)}</td>
                  <td>
                    <span className="count-badge">
                      {Object.keys(user.variables).length}
                    </span>
                  </td>
                  <td>
                    <button
                      className="text-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelected(user);
                        setVariables(JSON.stringify(user.variables, null, 2));
                      }}
                    >
                      Открыть
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          icon={<Users size={27} />}
          title={
            Object.values(filters).some(Boolean)
              ? "Никого не нашли"
              : "Пользователей пока нет"
          }
        >
          {Object.values(filters).some(Boolean)
            ? "Попробуйте изменить условия поиска."
            : "Запустите бота и отправьте ему /start в Telegram. Пользователь появится здесь автоматически."}
        </Empty>
      )}
      {users.length > 0 && (
        <div className="pagination">
          <span>
            {(currentPage - 1) * pageSize + 1}–
            {Math.min(currentPage * pageSize, users.length)} из {users.length}
          </span>
          <div>
            <button
              className="button secondary small"
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
            >
              Назад
            </button>
            <span>
              Страница {currentPage} из {pageCount}
            </span>
            <button
              className="button secondary small"
              disabled={currentPage >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              Далее
            </button>
          </div>
        </div>
      )}
      {selected && (
        <Modal
          title={
            [selected.firstName, selected.lastName].filter(Boolean).join(" ") ||
            "Пользователь"
          }
          subtitle={
            selected.username
              ? `@${selected.username} · ${selected.telegramUserId}`
              : String(selected.telegramUserId)
          }
          onClose={() => {
            setSelected(null);
            setConfirmDelete(false);
          }}
        >
          <div className="user-details">
            <div>
              <span>Первое обращение</span>
              <strong>{formatDate(selected.firstStartedAt)}</strong>
            </div>
            <div>
              <span>Последняя активность</span>
              <strong>{formatDate(selected.lastActivityAt)}</strong>
            </div>
            <div>
              <span>Текущий блок</span>
              <strong className="mono">
                {selected.currentNode || "Нет ожидающего ответа"}
              </strong>
            </div>
          </div>
          <Field
            label="Переменные пользователя"
            hint='JSON-объект. Например: {"name": "Анна", "subscribed": true}'
          >
            <textarea
              className="code-input"
              rows={9}
              value={variables}
              onChange={(e) => setVariables(e.target.value)}
            />
          </Field>
          {confirmDelete ? (
            <div className="delete-confirm">
              <p>
                Удалить пользователя и его переменные из базы? При новом
                обращении к боту он появится снова.
              </p>
              <button
                className="button danger-button"
                onClick={async () => {
                  try {
                    await window.flowra.deleteUser({
                      projectId: project.id,
                      userId: selected.id,
                    });
                    setSelected(null);
                    setConfirmDelete(false);
                    await load();
                  } catch (error: any) {
                    onError(error.message);
                  }
                }}
              >
                Да, удалить
              </button>
              <button
                className="text-button"
                onClick={() => setConfirmDelete(false)}
              >
                Отмена
              </button>
            </div>
          ) : (
            <div className="modal-actions split-actions">
              <button
                className="text-button danger"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={14} />
                Удалить пользователя
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={saveVariables}
              >
                {busy ? "Сохранение…" : "Сохранить"}
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

const broadcastStatus: Record<Broadcast["status"], string> = {
  queued: "В очереди",
  running: "Отправляется",
  completed: "Завершена",
  cancelled: "Отменена",
  interrupted: "Прервана",
};

export function BroadcastsPage({
  project,
  onError,
  onNotice,
}: {
  project: Project;
  onError: (text: string) => void;
  onNotice: (text: string) => void;
}) {
  const [content, setContent] = useState<BroadcastContent>({
    type: "sendMessage",
    text: "",
    parseMode: "",
  });
  const [filters, setFilters] = useState<UserFilter>({ blocked: false });
  const [recipients, setRecipients] = useState(0);
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  async function load() {
    try {
      setBroadcasts(await window.flowra.listBroadcasts(project.id));
    } catch (error: any) {
      onError(error.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    return window.flowra.onEvent((event) => {
      if (event.projectId === project.id && event.type === "broadcast") load();
    });
  }, [project.id]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      window.flowra
        .listUsers({ projectId: project.id, filters })
        .then((users) => {
          if (active)
            setRecipients(users.filter((user) => !user.blocked).length);
        })
        .catch((error) => onError(error.message));
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [project.id, JSON.stringify(filters)]);
  async function send() {
    setBusy(true);
    try {
      await window.flowra.createBroadcast({
        projectId: project.id,
        content,
        filters,
      });
      setConfirm(false);
      onNotice(
        "Рассылка добавлена в очередь. Здесь можно следить за доставкой.",
      );
      await load();
    } catch (error: any) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="management-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Связь с аудиторией</span>
          <h1>Рассылки</h1>
          <p>Отправьте сообщение всем пользователям или выбранной группе.</p>
        </div>
      </div>
      <div className="broadcast-layout">
        <section className="content-panel">
          <div className="section-heading">
            <h2>Новая рассылка</h2>
            <Send size={17} />
          </div>
          <Field label="Тип сообщения">
            <select
              value={content.type}
              onChange={(e) =>
                setContent({
                  ...content,
                  type: e.target.value as BroadcastContent["type"],
                })
              }
            >
              <option value="sendMessage">Текст</option>
              <option value="sendPhoto">Фотография</option>
              <option value="sendVideo">Видео</option>
              <option value="sendDocument">Документ</option>
            </select>
          </Field>
          {content.type !== "sendMessage" && (
            <MediaField
              projectId={project.id}
              kind={content.type}
              value={content.media || ""}
              onChange={(media) => setContent({ ...content, media })}
              onError={onError}
            />
          )}
          <Field
            label={content.type === "sendMessage" ? "Сообщение" : "Подпись"}
            hint="Можно использовать {{user.first_name}} и пользовательские переменные."
          >
            <textarea
              rows={6}
              placeholder="Напишите сообщение для вашей аудитории…"
              value={
                (content.type === "sendMessage"
                  ? content.text
                  : content.caption) || ""
              }
              onChange={(e) =>
                setContent({
                  ...content,
                  [content.type === "sendMessage" ? "text" : "caption"]:
                    e.target.value,
                })
              }
            />
          </Field>
          <Field label="Формат текста">
            <select
              value={content.parseMode || ""}
              onChange={(e) =>
                setContent({ ...content, parseMode: e.target.value })
              }
            >
              <option value="">Обычный текст</option>
              <option value="HTML">HTML</option>
              <option value="MarkdownV2">MarkdownV2</option>
            </select>
          </Field>
          <div className="form-divider" />
          <h3 className="form-subheading">Получатели</h3>
          <FilterFields compact value={filters} onChange={setFilters} />
          <div className="recipient-summary">
            <Users size={17} />
            <div>
              <strong>{recipients} получателей</strong>
              <small>Пользователи, которым бот может написать</small>
            </div>
          </div>
          <button
            className="button primary full-width"
            disabled={
              busy ||
              !recipients ||
              (content.type === "sendMessage"
                ? !content.text?.trim()
                : !content.media?.trim())
            }
            onClick={() => setConfirm(true)}
          >
            <Send size={16} />
            Отправить рассылку
          </button>
          <p className="fine-print">
            Очередь соблюдает ограничения Telegram. Приложение должно оставаться
            открытым до завершения отправки.
          </p>
        </section>
        <section className="broadcast-history">
          <div className="section-heading">
            <h2>История рассылок</h2>
            <span className="subtle-count">{broadcasts.length}</span>
          </div>
          {loading ? (
            <Busy />
          ) : !broadcasts.length ? (
            <Empty icon={<Send size={24} />} title="Рассылок ещё не было">
              Отправленные сообщения и их результаты будут здесь.
            </Empty>
          ) : (
            broadcasts.map((broadcast) => (
              <article key={broadcast.id} className="broadcast-card">
                <div className="broadcast-card-top">
                  <span
                    className={`status-pill ${broadcast.status === "running" || broadcast.status === "queued" ? "running" : ""}`}
                  >
                    {["running", "queued"].includes(broadcast.status) ? (
                      <span className="status-dot" />
                    ) : (
                      <CircleCheck size={12} />
                    )}
                    {broadcastStatus[broadcast.status]}
                  </span>
                  <small>{formatDate(broadcast.createdAt)}</small>
                </div>
                <p>
                  {broadcast.content.text ||
                    broadcast.content.caption ||
                    broadcast.content.media}
                </p>
                <div className="progress-track">
                  <div
                    style={{
                      width: `${broadcast.total ? ((broadcast.sent + broadcast.failed) / broadcast.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <div className="broadcast-counts">
                  <span>
                    <CircleCheck size={13} />
                    {broadcast.sent} доставлено
                  </span>
                  <span>
                    <AlertTriangle size={13} />
                    {broadcast.failed} ошибок
                  </span>
                  <span>из {broadcast.total}</span>
                </div>
                {["queued", "running"].includes(broadcast.status) && (
                  <button
                    className="text-button danger"
                    onClick={async () => {
                      try {
                        await window.flowra.cancelBroadcast(broadcast.id);
                        await load();
                      } catch (error: any) {
                        onError(error.message);
                      }
                    }}
                  >
                    <Square size={12} />
                    Остановить рассылку
                  </button>
                )}
              </article>
            ))
          )}
        </section>
      </div>
      {confirm && (
        <Modal
          title="Отправить рассылку?"
          subtitle={`Сообщение получат ${recipients} пользователей.`}
          onClose={() => setConfirm(false)}
        >
          <div className="message-preview">
            {content.text || content.caption || content.media}
          </div>
          <p className="field-note">
            Уже отправленные сообщения нельзя будет отозвать через Flowra. Можно
            остановить оставшуюся очередь.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setConfirm(false)}
            >
              Вернуться к редактированию
            </button>
            <button className="button primary" disabled={busy} onClick={send}>
              {busy ? "Постановка в очередь…" : "Отправить"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function ConsolePage({
  project,
  onError,
  onNotice,
}: {
  project: Project;
  onError: (text: string) => void;
  onNotice: (text: string) => void;
}) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState("all");
  async function load() {
    try {
      setLogs(await window.flowra.listLogs(project.id));
    } catch (error: any) {
      onError(error.message);
    }
  }
  useEffect(() => {
    load();
    return window.flowra.onEvent((event) => {
      if (event.projectId === project.id && event.type === "log") load();
    });
  }, [project.id]);
  const shown = logs.filter((log) => filter === "all" || log.level === filter);
  return (
    <div className="management-page console-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Работа бота</span>
          <h1>Консоль</h1>
          <p>Запуск, входящие события и ошибки выполнения сценария.</p>
        </div>
        <span
          className={`status-pill ${project.status === "running" ? "running" : ""}`}
        >
          <span className="status-dot" />
          {project.status === "running"
            ? "Бот работает"
            : project.status === "error"
              ? "Ошибка запуска"
              : "Бот остановлен"}
        </span>
      </div>
      <div className="console-toolbar">
        <div className="segment-control">
          {[
            ["all", "Все"],
            ["info", "События"],
            ["warn", "Предупреждения"],
            ["error", "Ошибки"],
          ].map(([key, title]) => (
            <button
              key={key}
              className={filter === key ? "active" : ""}
              onClick={() => setFilter(key)}
            >
              {title}
            </button>
          ))}
        </div>
        <div className="button-row">
          <IconButton title="Обновить" onClick={load}>
            <RefreshCw size={16} />
          </IconButton>
          <IconButton
            title="Скопировать журнал"
            disabled={!shown.length}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  shown
                    .map(
                      (log) =>
                        `[${log.createdAt}] ${log.level}: ${log.message}`,
                    )
                    .join("\n"),
                );
                onNotice("Журнал скопирован.");
              } catch (error: any) {
                onError(error.message);
              }
            }}
          >
            <Copy size={16} />
          </IconButton>
          <IconButton
            title="Очистить журнал"
            disabled={!logs.length}
            onClick={async () => {
              try {
                await window.flowra.clearLogs(project.id);
                await load();
              } catch (error: any) {
                onError(error.message);
              }
            }}
          >
            <Trash2 size={16} />
          </IconButton>
        </div>
      </div>
      <div className="console-output">
        {!shown.length ? (
          <div className="console-empty">
            <Terminal size={24} />
            <strong>Журнал пуст</strong>
            <span>
              {project.status === "running"
                ? "Бот запущен. Ожидаем первое событие."
                : "Нажмите «Запустить», чтобы увидеть события бота."}
            </span>
          </div>
        ) : (
          shown.map((log) => (
            <div className={`log-line ${log.level}`} key={log.id}>
              <time>{new Date(log.createdAt).toLocaleTimeString("ru")}</time>
              <span className="log-level">{log.level}</span>
              <span>{log.message}</span>
            </div>
          ))
        )}
      </div>
      <div className="console-bottom">
        {shown.length} записей<span>Токены скрываются в журнале.</span>
      </div>
    </div>
  );
}

export function AssetsModal({
  projectId,
  onClose,
  onError,
  onNotice,
}: {
  projectId: string;
  onClose: () => void;
  onError: (text: string) => void;
  onNotice: (text: string) => void;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  async function load() {
    try {
      setAssets(await window.flowra.listAssets(projectId));
    } catch (error: any) {
      onError(error.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [projectId]);
  const unused = assets.filter((asset) => asset.unused);
  return (
    <Modal
      title="Файлы проекта"
      subtitle="Файлы копируются в папку проекта и входят в экспорт."
      wide
      onClose={onClose}
    >
      {loading ? (
        <Busy />
      ) : !assets.length ? (
        <Empty icon={<FolderOpen size={26} />} title="Файлов пока нет">
          Добавьте медиа-блок и нажмите «Выбрать файл» в его свойствах.
        </Empty>
      ) : (
        <div className="asset-list">
          {assets.map((asset) => (
            <div key={asset.id} className="asset-row">
              {asset.preview && asset.mime.startsWith("image/") ? (
                <img src={asset.preview} alt="" />
              ) : (
                <span className="asset-file-icon">
                  <FolderOpen size={20} />
                </span>
              )}
              <div>
                <strong>{asset.name}</strong>
                <small>
                  {asset.mime} · {formatSize(asset.size)}
                </small>
                <code>{asset.path}</code>
              </div>
              {asset.unused && (
                <span className="status-pill">Не используется</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="modal-actions split-actions">
        <span className="muted small-text">
          {assets.length} файлов ·{" "}
          {formatSize(assets.reduce((total, asset) => total + asset.size, 0))}
        </span>
        <button
          className="button secondary"
          disabled={!unused.length || busy}
          onClick={async () => {
            if (!confirm) {
              setConfirm(true);
              return;
            }
            setBusy(true);
            try {
              const count = await window.flowra.cleanupAssets(projectId);
              onNotice(`Удалено неиспользуемых файлов: ${count}.`);
              await load();
              setConfirm(false);
            } catch (error: any) {
              onError(error.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Trash2 size={15} />
          {busy
            ? "Очистка…"
            : confirm
              ? `Удалить ${unused.length} файлов?`
              : `Очистить неиспользуемые (${unused.length})`}
        </button>
      </div>
      {confirm && (
        <p className="fine-print">
          Будут удалены только файлы, на которые больше не ссылается сценарий.
        </p>
      )}
    </Modal>
  );
}
