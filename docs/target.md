# 理想情况

## 顶层角色

顶层 supervisor 负责不同 session 的分派，每一个 session 即一个任务，由 当前session 的planner 进行任务规划与执行。创建 session 时初始化planner，metacog，和对应 session 的图数据库

## server 端

根据不同session，server 统一提供 restful 类型接口进行图数据库的访问，所有接口都是POST 请求方式发起，

数据库必须持久化到对应 session，禁止内存数据库、临时数据库或其他无持久化状态源。Federation 数据同样必须持久化。

由各个session 角色在 prompt 构造时根据各自权限对server发起请求，查询到内容后，落地到统一命名格式文件，并放在对应session目录下，以标准json格式存储。最后将文件引用，标准 prompt，还有定制化 prompt 加载到 prompt builder

graph 中状态的流转和 server 强绑定，任何角色只能通过 server 间接对graph 进行影响，而不能够直接修改或访问graph。所以，server graph 不应该依赖任何角色，任何角色也不应该直接操作数据库。

planner、explorer、evaluator、metacog 均不得获得数据库对象或数据库文件。角色只读取 server 按 profile 生成并落地的标准 JSON 文件，只输出标准 JSON；输出先落地，再由 server 校验权限和合同后提交 Graph。

## Session 角色

| 环节 | 作用 | 能力 |
| --- | --- | --- |
| planner | 将大的任务拆分为原子化任务，例如分析指定类任务，获取指定组件信息等等，创建intent，启动explorer | create_intent, fail_intent, handle_hint, create_subagent_explorer, stop_subagent_explorer, create_end_fact |
| explorer | 完成原子任务并写入candidate fact | handle_intent, write_candidate_fact|
| evaluator | 出现 candidate fact 时触发，判定 fact 是否准确，或接收到 fact 广播时触发 | change_fact， receive_fact_broadcast |
| metacog | 每一次 accept fact 入图时触发/整个分析流程结束时触发，整体纠偏，广播 | create_hint, get_graph, send_fact_broadcast |

每一个角色都能够通过配置文件注入特定 prompt，从而执行指定领域的任务，同时也支持接入指定领域知识/规范/skill。
每一个角色都有初始化的 system prompt，并以最简洁明了的方式说明职责，能够进行高度化定制，例如，能够多开 explorer_gather，explorer_analysis 等

## 状态流转

intent: DAG 边

open（待做）
claimed（explorer 正在执行，占位防重）
pass（做完，产 candidate fact）
deny（dead-end）planner 根据 accept fact 判断

Fact：DAG节点

candidate（初始，刚产出待审）
pass（采纳，可作 intent 的 parent）
deny（否决）
pending（条件未齐，留门等 federation 补）

intent_sets：多fact创建intent时记录

## 任务结束标记

多 session 同时执行时，认为这是一组关联任务，当所有 planner 判定结束且无 fact 广播之后，任务结束

## UI

通过 server 侧获取统一的 图状态，并且绘制在web上
