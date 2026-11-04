import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useReactFlow,
  type NodeProps,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type Node,
  type Edge,
} from "@xyflow/react";
import {
  Search,
  Undo2,
  Redo2,
  Scan,
  Plus,
  Check,
  Loader2,
  ChevronRight,
  GitBranch,
} from "lucide-react";
import type {
  FlowNode,
  Workflow,
  Project,
  NodeKind,
  NodeData,
} from "../shared/types";
import { catalog, groups, nodeSummary } from "./catalog";
import Properties from "./Properties";
import { IconButton } from "./ui";
import "@xyflow/react/dist/style.css";

const WorkflowNode = memo(function WorkflowNode({
  id,
  type,
  data,
  selected,
}: NodeProps) {
  const kind = type as NodeKind;
  const definition = catalog[kind];
  const Icon = definition.icon;
  const isTrigger = ["start", "command", "message", "callback"].includes(kind);
  const outputs =
    kind === "condition"
      ? [
          { id: "true", label: "Да" },
          { id: "false", label: "Нет" },
        ]
      : kind === "switch"
        ? [
            ...((data.cases as any[]) || []).map((item) => ({
              id: item.handle,
              label: String(item.value || item.handle),
            })),
            { id: "default", label: "Иначе" },
          ]
        : [{ id: null, label: "" }];
  return (
    <div
      className={`flow-node ${selected ? "selected" : ""} ${isTrigger ? "trigger-node" : ""}`}
    >
      <div className="node-top">
        <span className="node-icon">
          <Icon size={16} />
        </span>
        <strong>{String(data.label || definition.title)}</strong>
        <span className="node-dots">···</span>
      </div>
      <div className="node-content">{nodeSummary(kind, data)}</div>
      <div className="node-bottom">
        <span>{definition.title}</span>
        {outputs.length === 1 && <ChevronRight size={12} />}
      </div>
      {!isTrigger && <Handle type="target" position={Position.Left} />}
      <div className="node-outputs">
        {outputs.map((output, index) => (
          <div key={output.id || "out"}>
            {output.label && (
              <span
                style={{
                  top: `${((index + 1) / (outputs.length + 1)) * 100}%`,
                }}
                className="handle-label"
              >
                {output.label}
              </span>
            )}
            <Handle
              id={output.id}
              type="source"
              position={Position.Right}
              style={{ top: `${((index + 1) / (outputs.length + 1)) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <span className="node-id">{id.slice(0, 6)}</span>
    </div>
  );
});

const nodeTypes = Object.fromEntries(
  Object.keys(catalog).map((kind) => [kind, WorkflowNode]),
);
const edgeOptions = { type: "smoothstep", style: { strokeWidth: 1.5 } };

export default function Editor(props: {
  project: Project;
  onWorkflow: (workflow: Workflow) => void;
  onError: (message: string) => void;
  dark: boolean;
}) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}

function EditorInner({
  project,
  onWorkflow,
  onError,
  dark,
}: {
  project: Project;
  onWorkflow: (workflow: Workflow) => void;
  onError: (message: string) => void;
  dark: boolean;
}) {
  const [workflow, setWorkflow] = useState<Workflow>(() =>
    structuredClone(project.workflow),
  );
  const graph = useRef(workflow);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">(
    "saved",
  );
  const [, setHistoryVersion] = useState(0);
  const past = useRef<Workflow[]>([]);
  const future = useRef<Workflow[]>([]);
  const clipboard = useRef<Workflow | null>(null);
  const flow = useReactFlow();
  const saved = useRef(JSON.stringify(project.workflow));
  const callback = useRef(onWorkflow);
  callback.current = onWorkflow;
  graph.current = workflow;

  const checkpoint = useCallback(() => {
    past.current = [...past.current.slice(-79), structuredClone(graph.current)];
    future.current = [];
    setHistoryVersion((value) => value + 1);
  }, []);

  const update = useCallback(
    (next: Workflow | ((current: Workflow) => Workflow), track = true) => {
      if (track) checkpoint();
      setWorkflow((current) =>
        typeof next === "function" ? next(current) : next,
      );
    },
    [checkpoint],
  );

  useEffect(() => {
    callback.current(workflow);
    const serialized = JSON.stringify({
      ...workflow,
      nodes: workflow.nodes.map(({ selected: _selected, ...node }) => node),
      edges: workflow.edges.map(({ selected: _selected, ...edge }) => edge),
    });
    if (serialized === saved.current) return;
    setSaveState("saving");
    const timer = setTimeout(() => {
      window.flowra
        .saveWorkflow({ id: project.id, workflow: JSON.parse(serialized) })
        .then(() => {
          saved.current = serialized;
          setSaveState("saved");
        })
        .catch((error) => {
          setSaveState("error");
          onError(error.message);
        });
    }, 650);
    return () => clearTimeout(timer);
  }, [workflow, project.id]);

  useEffect(
    () => () => {
      window.flowra
        .saveWorkflow({ id: project.id, workflow: graph.current })
        .catch((error) => onError(error.message));
    },
    [project.id],
  );

  function undo() {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(structuredClone(graph.current));
    setWorkflow(previous);
    setHistoryVersion((value) => value + 1);
  }
  function redo() {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(structuredClone(graph.current));
    setWorkflow(next);
    setHistoryVersion((value) => value + 1);
  }
  function duplicate(
    nodes = graph.current.nodes.filter((node) => node.selected),
    sourceEdges = graph.current.edges,
  ) {
    if (!nodes.length) return;
    const ids = new Map(nodes.map((node) => [node.id, crypto.randomUUID()]));
    const copies = nodes.map((node) => ({
      ...structuredClone(node),
      id: ids.get(node.id)!,
      position: { x: node.position.x + 45, y: node.position.y + 55 },
      selected: true,
    }));
    const edges = sourceEdges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({
        ...edge,
        id: crypto.randomUUID(),
        source: ids.get(edge.source)!,
        target: ids.get(edge.target)!,
      }));
    update((current) => ({
      ...current,
      nodes: [
        ...current.nodes.map((node) => ({ ...node, selected: false })),
        ...copies,
      ],
      edges: [...current.edges, ...edges],
    }));
    setSelectedId(copies[0].id);
  }
  function remove(
    ids = graph.current.nodes
      .filter((node) => node.selected)
      .map((node) => node.id),
  ) {
    update((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !ids.includes(node.id)),
      edges: current.edges.filter(
        (edge) =>
          !ids.includes(edge.source) &&
          !ids.includes(edge.target) &&
          !edge.selected,
      ),
    }));
    setSelectedId(null);
  }

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input,textarea,select,[contenteditable="true"]'))
        return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.code === "KeyZ") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (mod && event.code === "KeyY") {
        event.preventDefault();
        redo();
      } else if (mod && event.code === "KeyD") {
        event.preventDefault();
        duplicate();
      } else if (mod && event.code === "KeyC") {
        const nodes = graph.current.nodes.filter((node) => node.selected);
        const ids = new Set(nodes.map((node) => node.id));
        clipboard.current = structuredClone({
          version: 1,
          nodes,
          edges: graph.current.edges.filter(
            (edge) => ids.has(edge.source) && ids.has(edge.target),
          ),
        });
        if (nodes.length) event.preventDefault();
      } else if (mod && event.code === "KeyV") {
        if (clipboard.current?.nodes.length) {
          event.preventDefault();
          duplicate(clipboard.current.nodes, clipboard.current.edges);
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  function addNode(kind: NodeKind, position?: { x: number; y: number }) {
    const center = flow.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    const node: FlowNode = {
      id: crypto.randomUUID(),
      type: kind,
      position: position || { x: center.x - 100, y: center.y - 60 },
      data: {
        label: catalog[kind].title,
        ...structuredClone(catalog[kind].defaults),
      },
      selected: true,
    };
    update((current) => ({
      ...current,
      nodes: [
        ...current.nodes.map((item) => ({ ...item, selected: false })),
        node,
      ],
    }));
    setSelectedId(node.id);
  }

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (changes.some((change) => change.type === "remove")) checkpoint();
      setWorkflow((current) => ({
        ...current,
        nodes: applyNodeChanges(changes, current.nodes as Node[]) as FlowNode[],
      }));
    },
    [checkpoint],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (changes.some((change) => change.type === "remove")) checkpoint();
      setWorkflow((current) => ({
        ...current,
        edges: applyEdgeChanges(changes, current.edges as Edge[]),
      }));
    },
    [checkpoint],
  );
  const onConnect = useCallback(
    (connection: Connection) =>
      update((current) => ({
        ...current,
        edges: addEdge(
          { ...connection, id: crypto.randomUUID() },
          current.edges,
        ),
      })),
    [update],
  );
  const selectedNode = workflow.nodes.find((node) => node.id === selectedId);
  const filteredKinds = (Object.keys(catalog) as NodeKind[]).filter((kind) =>
    `${catalog[kind].title} ${catalog[kind].hint}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  return (
    <div className="editor">
      <aside className="block-library">
        <div className="panel-title">
          Блоки
          <span className="subtle-count">{Object.keys(catalog).length}</span>
        </div>
        <div className="search small-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти блок"
            aria-label="Найти блок"
          />
        </div>
        <div className="library-scroll">
          {groups.map((group) => {
            const kinds = filteredKinds.filter(
              (kind) => catalog[kind].group === group,
            );
            return kinds.length ? (
              <section className="block-group" key={group}>
                <h3>{group}</h3>
                {kinds.map((kind) => {
                  const Icon = catalog[kind].icon;
                  return (
                    <button
                      key={kind}
                      className="library-block"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(
                          "application/flowra-node",
                          kind,
                        );
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => addNode(kind)}
                      title={catalog[kind].hint}
                    >
                      <Icon size={16} />
                      <span>{catalog[kind].title}</span>
                      <Plus size={13} className="block-add" />
                    </button>
                  );
                })}
              </section>
            ) : null;
          })}
          {!filteredKinds.length && (
            <p className="small-empty">Таких блоков нет.</p>
          )}
        </div>
        <div className="library-tip">
          Перетащите блок на схему
          <br />
          или нажмите, чтобы добавить.
        </div>
      </aside>
      <div
        className="canvas"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const kind = event.dataTransfer.getData(
            "application/flowra-node",
          ) as NodeKind;
          if (catalog[kind])
            addNode(
              kind,
              flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
            );
        }}
      >
        <div className="canvas-heading">
          <div>
            <GitBranch size={14} />
            <span>Основной сценарий</span>
          </div>
          <div className={`save-status ${saveState}`}>
            {saveState === "saving" ? (
              <Loader2 size={12} className="spin" />
            ) : (
              <Check size={12} />
            )}
            {saveState === "saving"
              ? "Сохраняется"
              : saveState === "error"
                ? "Ошибка сохранения"
                : "Сохранено"}
          </div>
        </div>
        <div className="canvas-actions">
          <IconButton
            title="Отменить · Ctrl Z"
            disabled={!past.current.length}
            onClick={undo}
          >
            <Undo2 size={16} />
          </IconButton>
          <IconButton
            title="Повторить · Ctrl Shift Z"
            disabled={!future.current.length}
            onClick={redo}
          >
            <Redo2 size={16} />
          </IconButton>
          <span className="toolbar-divider" />
          <IconButton
            title="Показать всю схему"
            onClick={() => flow.fitView({ padding: 0.3, duration: 180 })}
          >
            <Scan size={16} />
          </IconButton>
        </div>
        <ReactFlow
          nodes={workflow.nodes as Node[]}
          edges={workflow.edges as Edge[]}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          onNodeDragStart={checkpoint}
          onSelectionDragStart={checkpoint}
          onSelectionChange={({ nodes }) => {
            if (nodes.length === 1) setSelectedId(nodes[0].id);
            else if (!nodes.length) setSelectedId(null);
          }}
          defaultEdgeOptions={edgeOptions}
          fitView
          fitViewOptions={{ padding: 0.4, maxZoom: 1 }}
          minZoom={0.15}
          maxZoom={2}
          colorMode={dark ? "dark" : "light"}
          ariaLabelConfig={{
            'node.a11yDescription.default': 'Enter или пробел — выбрать блок. Delete — удалить, Escape — отменить выделение.',
            'node.a11yDescription.keyboardDisabled': 'Enter или пробел — выбрать блок. Escape — отменить выделение.',
            'edge.a11yDescription.default': 'Enter или пробел — выбрать связь. Delete — удалить, Escape — отменить выделение.',
            'controls.ariaLabel': 'Управление схемой',
            'controls.zoomIn.ariaLabel': 'Приблизить',
            'controls.zoomOut.ariaLabel': 'Отдалить',
            'controls.fitView.ariaLabel': 'Показать всю схему',
            'controls.interactive.ariaLabel': 'Переключить редактирование',
            'minimap.ariaLabel': 'Обзор схемы',
            'handle.ariaLabel': 'Точка соединения',
          }}
          deleteKeyCode={["Backspace", "Delete"]}
          selectionOnDrag
          panOnDrag={[1, 2]}
          multiSelectionKeyCode={["Control", "Meta"]}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={dark ? "#3c344f" : "#dbd3f5"}
            maskColor={dark ? "#151518b0" : "#f5f4f1a0"}
          />
        </ReactFlow>
        <div className="canvas-meta">
          {workflow.nodes.length} блоков<span>·</span>
          {workflow.edges.length} связей
          {project.status === "running" && (
            <>
              <span>·</span>Изменения применятся после перезапуска
            </>
          )}
        </div>
      </div>
      <Properties
        node={selectedNode}
        projectId={project.id}
        nodes={workflow.nodes}
        onChange={(data: NodeData) =>
          update((current) => ({
            ...current,
            nodes: current.nodes.map((node) =>
              node.id === selectedId ? { ...node, data } : node,
            ),
          }))
        }
        onDelete={() => remove(selectedId ? [selectedId] : undefined)}
        onDuplicate={() => duplicate(selectedNode ? [selectedNode] : [])}
        onError={onError}
      />
    </div>
  );
}
