import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Check, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { PlanListItem } from "./parts/ListItem";
import { PlanProgressBar } from "./parts/ProgressBar";
import { calculatePlanProgress, shouldCelebrateProgress } from "./progress";
import type { PlanProps, PlanTodo } from "./types";

const INITIAL_VISIBLE_TODO_COUNT = 4;

type TodoListProps = {
  todos: PlanTodo[];
  newTodoIds: Set<string>;
};

function TodoList({ todos, newTodoIds }: TodoListProps) {
  return (
    <>
      {todos.map((todo, index) => {
        const isNew = newTodoIds.has(todo.id);
        const staggerDelay = isNew ? index * 50 : 0;
        const style: CSSProperties | undefined = isNew
          ? {
              animationDelay: `${staggerDelay}ms`,
              animationFillMode: "backwards",
            }
          : undefined;
        return (
          <PlanListItem
            key={todo.id}
            status={todo.status}
            label={todo.label}
            showConnector={index < todos.length - 1}
            className={cn(
              isNew &&
                "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 motion-safe:ease-out",
            )}
            style={style}
          >
            {todo.description ? (
              <p className="text-muted-foreground text-sm text-pretty break-words">
                {todo.description}
              </p>
            ) : undefined}
          </PlanListItem>
        );
      })}
    </>
  );
}

function PlanRoot({
  id,
  title,
  description,
  todos,
  maxVisibleTodos = INITIAL_VISIBLE_TODO_COUNT,
  className,
  compact = false,
}: PlanProps & { compact?: boolean }) {
  const seenTodoIds = useRef(new Set<string>());
  const [newTodoIds, setNewTodoIds] = useState<Set<string>>(new Set());
  const [isCelebrating, setIsCelebrating] = useState(false);
  const prevProgressRef = useRef(0);

  const { visibleTodos, hiddenTodos, completedCount, allComplete, progress } =
    useMemo(() => {
      const completed = todos.filter(t => t.status === "completed").length;
      return {
        visibleTodos: todos.slice(0, maxVisibleTodos),
        hiddenTodos: todos.slice(maxVisibleTodos),
        completedCount: completed,
        allComplete: completed === todos.length,
        progress: calculatePlanProgress({
          completedCount: completed,
          totalCount: todos.length,
        }),
      };
    }, [todos, maxVisibleTodos]);

  useEffect(() => {
    const newIds = new Set<string>();
    todos.forEach(todo => {
      if (!seenTodoIds.current.has(todo.id)) {
        newIds.add(todo.id);
        seenTodoIds.current.add(todo.id);
      }
    });

    if (newIds.size > 0) {
      setNewTodoIds(newIds);
      const timer = setTimeout(() => setNewTodoIds(new Set()), 500);
      return () => clearTimeout(timer);
    }
  }, [todos]);

  useEffect(() => {
    const shouldCelebrate = shouldCelebrateProgress({
      previous: prevProgressRef.current,
      next: progress,
    });
    prevProgressRef.current = progress;
    if (shouldCelebrate) {
      setIsCelebrating(true);
      const timer = setTimeout(() => setIsCelebrating(false), 1000);
      return () => clearTimeout(timer);
    }
  }, [progress]);

  const todoList = (
    <ul className={cn("min-w-0 space-y-1", compact ? "mt-0" : "mt-4")}>
      <TodoList todos={visibleTodos} newTodoIds={newTodoIds} />
      {hiddenTodos.length > 0 && (
        <li className="mt-1">
          <Accordion type="single" collapsible>
            <AccordionItem value="more" className="border-0">
              <AccordionTrigger className="text-muted-foreground hover:text-primary flex cursor-default items-start justify-start gap-2 py-1 text-sm font-normal [&>svg:last-child]:hidden">
                <MoreHorizontal className="text-muted-foreground/70 mt-0.5 size-4 shrink-0" />
                <span>{hiddenTodos.length} more</span>
              </AccordionTrigger>
              <AccordionContent className="pt-2 pb-0">
                <ul className="-mx-2 space-y-2 px-2">
                  <TodoList todos={hiddenTodos} newTodoIds={newTodoIds} />
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </li>
      )}
    </ul>
  );

  return (
    <Card
      className={cn("isolate w-full max-w-xl min-w-80 gap-4 py-4", className)}
      data-tool-ui-id={id}
      data-slot="plan"
    >
      {!compact && (
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle className="leading-5 font-medium text-pretty">
              {title}
            </CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          {allComplete && (
            <Check className="mt-0.5 size-5 shrink-0 text-success" />
          )}
        </CardHeader>
      )}
      <CardContent className="min-w-0 px-4">
        <div
          className={cn(
            "min-w-0",
            !compact && "bg-muted/70 rounded-lg px-6 py-4",
          )}
        >
          {!compact && (
            <>
              <div className="text-muted-foreground mb-2 text-sm">
                {completedCount} of {todos.length} complete
              </div>
              <PlanProgressBar
                progress={progress}
                isCelebrating={isCelebrating}
              />
            </>
          )}
          {todoList}
        </div>
      </CardContent>
    </Card>
  );
}

function PlanComponent(props: PlanProps) {
  return <PlanRoot key={props.id} {...props} />;
}

export function PlanCompact(props: PlanProps) {
  return <PlanRoot key={props.id} {...props} compact />;
}

type PlanComponentType = typeof PlanComponent & {
  Compact: typeof PlanCompact;
};

export const Plan = Object.assign(memo(PlanComponent), {
  Compact: PlanCompact,
}) as unknown as PlanComponentType;
