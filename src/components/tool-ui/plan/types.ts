/**
 * Plain TypeScript types for the Plan surface.
 *
 * The upstream tool-ui registry ships a zod-based schema (`schema.ts`) that
 * doubles as a runtime parser for untrusted payloads. We don't need that
 * here — Plan props in this codebase always come from our own runtime, so
 * we keep static types only and skip the zod dependency.
 */

export type PlanTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed";

export type PlanTodo = {
  id: string;
  label: string;
  status: PlanTodoStatus;
  description?: string;
};

export type PlanProps = {
  id: string;
  title: string;
  description?: string;
  todos: PlanTodo[];
  maxVisibleTodos?: number;
  className?: string;
};
