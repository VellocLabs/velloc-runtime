// A sample app for the studio catalog's dev page: a dashboard, and a model
// picker in a modal whose rows come from `/data/rows`.

export const DASHBOARD_SURFACE_ID = 'studio-dev'

export const DASHBOARD_EXPRESS = `surface("${DASHBOARD_SURFACE_ID}")
root = Column([head, top_bar, stats_grid, models_table], gap=4)
head = Heading("AI 模型管理控制台 (Model Management Dashboard)", subtitle="监控并管理已配置的生产环境模型端点与调用状态", level="1")
top_bar = Row([badge_status, spacer_bar, refresh_btn, picker], align="center", gap=3)
badge_status = Badge($/data/status, variant="soft", color="success")
spacer_bar = Spacer()
refresh_btn = Button("刷新状态", onClick=Event("refresh_status"), variant="default", icon="refresh-cw")
picker = Modal(trigger=select_model_btn, content=pick_body, title="选择模型 (Select Models)", maxWidth=720)
select_model_btn = Button("+ 选择模型 (Select Models)", variant="primary", icon="plus")
pick_body = Column([pick_search, pick_scroll], gap=3)
pick_scroll = Column([pick_list], maxHeight="320px", scrollable=true)
pick_search = TextField("搜索", value=$/data/query, placeholder="模型名称")
pick_list = Column(_template($/data/rows, pick_row), gap=2)
pick_row = Row([pick_mark, pick_name, pick_provider, pick_spacer, pick_btn], align="center", gap=3)
pick_mark = Text($mark)
pick_name = Text($name)
pick_provider = Badge($provider, variant="soft")
pick_spacer = Spacer()
pick_btn = Button($label, onClick=Event("pick", {step: $step, model: $id, query: $/data/query}), variant="default")
stats_grid = Grid([stat_active, stat_providers, stat_latency, stat_cost], columns=4, gap=3)
stat_active = Stat("已启用模型", $/data/active, delta="+1 本周", trend="up", caption="当前路由可用", tone="positive")
stat_providers = Stat("接入服务商", "5", caption="Northwind, Lakeshore 等", tone="default")
stat_latency = Stat("平均延迟", "380ms", delta="-45ms", trend="down", caption="P95 响应时间", tone="positive")
stat_cost = Stat("本月预估花费", "$42.80", delta="+12%", trend="up", caption="预算限额 $150.00", tone="info")
models_table = DataTable("已启用模型列表 (Active Models)", [{"key": "model", "label": "模型名称"}, {"key": "provider", "label": "提供商"}, {"key": "context", "label": "上下文长度"}, {"key": "latency", "label": "平均延迟"}, {"key": "pricing", "label": "计费费率 (1M tokens)"}, {"key": "status", "label": "运行状态"}, {"key": "action", "label": "操作"}], [{"model": "Atlas Large", "provider": "Northwind", "context": "128k", "latency": "280ms", "pricing": "$2.50 / $10.00", "status": "Active", "action": "配置"}, {"model": "Borealis Pro", "provider": "Lakeshore", "context": "200k", "latency": "310ms", "pricing": "$3.00 / $15.00", "status": "Active", "action": "配置"}, {"model": "Cirrus Mini", "provider": "Harbor", "context": "64k", "latency": "240ms", "pricing": "$0.14 / $0.28", "status": "Active", "action": "配置"}], searchable=true, pageSize=6)
`

const MODELS: readonly { id: string; name: string; provider: string }[] = Array.from({ length: 14 }, (_, i) => ({
  id: `model-${i + 1}`,
  name: `Model ${i + 1}`,
  provider: i % 2 ? 'OpenRouter' : 'OpenCode Go',
}))

export type DashboardState = { members: readonly string[]; refreshes: number }

export const DASHBOARD_START: DashboardState = { members: ['model-1', 'model-2', 'model-3'], refreshes: 0 }

/** The `/data` value the surface binds to. */
export function dashboardData(state: DashboardState): Record<string, unknown> {
  return {
    status: state.refreshes ? `系统运行正常 · ${state.refreshes}` : '系统运行正常',
    active: String(state.members.length),
    query: '',
    rows: MODELS.map(model => {
      const member = state.members.includes(model.id)
      return {
        ...model,
        mark: member ? '✓' : '',
        label: member ? '移除' : '添加',
        step: member ? 'remove' : 'add',
      }
    }),
  }
}

/** The state after one surface event. */
export function dashboardStep(state: DashboardState, name: string, context: Record<string, unknown> | undefined): DashboardState {
  if (name === 'refresh_status') return { ...state, refreshes: state.refreshes + 1 }
  const model = typeof context?.model === 'string' ? context.model : ''
  if (name !== 'pick' || !model) return state
  if (context?.step === 'add') return { ...state, members: [...state.members.filter(id => id !== model), model] }
  if (context?.step === 'remove') return { ...state, members: state.members.filter(id => id !== model) }
  return state
}
