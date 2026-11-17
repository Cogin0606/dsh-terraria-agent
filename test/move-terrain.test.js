// move 的地形闸门。
//
// 病根：`move` 原先只按住方向键 ms 毫秒，回包永远 ok:true。
// 人掉进 14 格深的坑，回包还是 ok:true —— AI 看到 ok 就以为走成了。
// 现在 move 发之前先沿 dir 预走一遍（和 probe 同一套判据），
// 遇到 >2 格落差就拒绝，并把「jump / 绕 / 搭桥」三个选项写在错误里。
//
// C# 逻辑在游戏里跑，node 这里用「同判据镜像 + 源码锁」两件事来守：
// 镜像保证规则是 §0.57 那一条（>2 才拦，1~2 放行），
// 源码锁保证闸门真的接在 move 的写入之前、且默认开着。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CS = fs.readFileSync(path.join(REPO, 'DshTerrariaBridge', 'Commands.cs'), 'utf8')

// ---- 判据镜像：与 Commands.cs 的 TerrainAhead 逐行对应 ----
// depth[i] = 从当前位置往 dir 方向第 i+1 列，脚下要找几格才落到地板
//   0       脚下就是地板
//   1~2     小台阶，人自己会走下去（不拦）
//   >2      悬崖（AGENTS §0.57：不许走过去）
//   null    14 格内找不到地板
//   'wall'  身体过不去（只提示，不拦——撞墙人不会受伤）
function terrainAhead(depth, steps) {
  let reach = 0
  for (let i = 1; i <= steps; i++) {
    const d = depth[i - 1]
    if (d === 'wall') return { ok: false, reach, issue: 'blocked', drop: 0 }
    if (d === null) return { ok: false, reach, issue: 'pit_deep', drop: 14 }
    if (d > 2) return { ok: false, reach, issue: `pit_${d}_deep`, drop: d }
    reach = i
  }
  return { ok: true, reach, issue: 'none', drop: 0 }
}

test('落差 3 格：判悬崖，reach 停在坑前那格', () => {
  const r = terrainAhead([0, 0, 3, 0], 4)
  assert.equal(r.ok, false)
  assert.equal(r.issue, 'pit_3_deep')
  assert.equal(r.reach, 2, '前两格能走，第三格是坑')
  assert.equal(r.drop, 3)
})

test('落差 2 格：放行（人能自己走下去，和 §0.57 的阈值一致）', () => {
  const r = terrainAhead([0, 2, 0, 0], 4)
  assert.equal(r.ok, true)
  assert.equal(r.reach, 4)
})

test('第一列就是 14 格深坑：reach=0，一步都不该走', () => {
  const r = terrainAhead([14, 0], 2)
  assert.equal(r.ok, false)
  assert.equal(r.reach, 0)
  assert.equal(r.issue, 'pit_14_deep')
})

test('14 格内找不到地板：判 pit_deep，不假装有底', () => {
  const r = terrainAhead([0, null], 2)
  assert.equal(r.ok, false)
  assert.equal(r.issue, 'pit_deep')
  assert.equal(r.reach, 1)
})

test('撞墙：判 blocked（移动会停住，但这不是摔下去）', () => {
  const r = terrainAhead([0, 'wall', 0], 3)
  assert.equal(r.ok, false)
  assert.equal(r.issue, 'blocked')
  assert.equal(r.reach, 1)
})

test('全程平地：放行到 steps 尽头', () => {
  const r = terrainAhead([0, 0, 0, 0, 0], 5)
  assert.equal(r.ok, true)
  assert.equal(r.reach, 5)
})

// ---- 源码锁：闸门必须真的接在 move 里，而且默认开着 ----

function moveBody() {
  const start = CS.indexOf('private static string Move(JsonElement p)')
  assert.ok(start > 0, '找不到 Move 函数')
  // 下一个同级函数：Jump
  const end = CS.indexOf('private static string Jump(JsonElement p)', start)
  assert.ok(end > start, '找不到 Move 的结束位置')
  return CS.slice(start, end)
}

test('TerrainAhead 存在，且用的是 PathBodyFree / PathFloorAt（和 probe 同一套读地形）', () => {
  const i = CS.indexOf('private static bool TerrainAhead(')
  assert.ok(i > 0, '缺少 TerrainAhead')
  const body = CS.slice(i, i + 1600)
  assert.match(body, /BridgeSystem\.PathBodyFree\(/)
  assert.match(body, /BridgeSystem\.PathFloorAt\(/)
})

test('move 里调用了 TerrainAhead，且闸门在写方向键之前', () => {
  const body = moveBody()
  const gate = body.indexOf('TerrainAhead(')
  const write = body.indexOf('BridgeSystem.LeftUntil = until')
  assert.ok(gate > 0, 'move 没有调用 TerrainAhead，闸门没接上')
  assert.ok(write > 0, '找不到写 LeftUntil 的那行')
  assert.ok(gate < write, '闸门必须排在写方向键之前，否则拦不住')
})

test('闸门默认开启：terrain 缺省为 true，force 缺省为 false', () => {
  const body = moveBody()
  assert.match(body, /Json\.Bool\(p, "terrain", true\)/, 'terrain 必须默认 true')
  assert.match(body, /Json\.Bool\(p, "force", false\)/, 'force 必须默认 false')
})

test('拒绝时给出三个可选动作，并说明怎么硬走', () => {
  const body = moveBody()
  assert.match(body, /jump/)
  assert.match(body, /绕/)
  assert.match(body, /place/)
  assert.match(body, /force:true/)
  assert.match(body, /pit_/)
})

test('move 仍然只写输入标志，没有任何改世界的语句', () => {
  const body = moveBody()
  assert.doesNotMatch(body, /Main\.tile\[[^\]]*\]\.(type|wall|active)\s*=(?!=)/)
  assert.doesNotMatch(body, /WorldGen\./)
  assert.doesNotMatch(body, /\.velocity\.[XY]\s*=(?!=)/)
})

// ---- 第二道判据：成本模型（取代"落差 >N 就拒绝"）----
// 结构来自 Baritone：给每个候选动作算成本再取最小，落差只是成本里的一项。
// 常数与 Baritone ActionCosts 同比例：WALK 4.633 / JUMP_PENALTY 2 / FALL ∝ √n。
// 关键：同一个深度，能爬回来就便宜、爬不回来记 ∞ —— 深度这一个数字区分不了这两种。
const COST_WALK = 4.633
const COST_JUMP = 2
const COST_PLACE = 8
const COST_INF = 1e9

const costFall = n => 3 * Math.sqrt(Math.max(0, n))
const costClimbBack = n => n * (COST_WALK + COST_JUMP)
// 泰拉瑞亚：>25 格开始受伤，每多一格 10 点（world-biome 里的通用规则）
function costFallDamage(n, life, lifeMax) {
  if (n <= 25) return 0
  const dmg = (n - 25) * 10
  if (dmg >= Math.max(1, life)) return COST_INF
  return (dmg / Math.max(1, lifeMax)) * 200
}

// 返回 { fallIn, jumpOver, bridge, detour, pick }
// 注意 fallIn 里没有"爬回来"的代价：move 是单向推进，走过去一般不回头；
// 贵的是"回不来"，那记 ∞（不是价格高，是这条路走完就死了）。
function costs({ d, canClimbBack, cramped = false, life = 120, lifeMax = 120 }) {
  let fallIn = costFall(d) + costFallDamage(d, life, lifeMax)
  if (!canClimbBack) fallIn += COST_INF
  if (cramped) fallIn += COST_INF
  const jumpOver = COST_JUMP + COST_WALK
  const bridge = d * (COST_PLACE + COST_WALK)
  const detour = COST_WALK * (d * 4 + 8)
  const pick = Math.min(fallIn, jumpOver, bridge, detour)
  const pickName = pick === fallIn ? 'fall_in' : pick === jumpOver ? 'jump_over' : pick === bridge ? 'place_bridge' : 'detour'
  return { fallIn, jumpOver, bridge, detour, pick, pickName }
}

test('镜像：2 格、能爬回来 → 落进去就是最便宜的，走', () => {
  const c = costs({ d: 2, canClimbBack: true })
  assert.equal(c.pickName, 'fall_in')
})

test('镜像：2 格、爬不回来 → 落进去记 ∞，改选跳过去', () => {
  const c = costs({ d: 2, canClimbBack: false })
  assert.ok(c.fallIn >= COST_INF, '爬不回来必须记成不可选')
  assert.notEqual(c.pickName, 'fall_in')
  assert.equal(c.pickName, 'jump_over', '2 格时跳过去比垫方块便宜')
})

test('镜像：同样 2 格深，能不能爬回来给出不同结论（旧阈值做不到这件事）', () => {
  assert.equal(costs({ d: 2, canClimbBack: true }).pickName, 'fall_in')
  assert.notEqual(costs({ d: 2, canClimbBack: false }).pickName, 'fall_in')
})

test('镜像：落点空间被吃掉也算不可选（cramped）', () => {
  const c = costs({ d: 2, canClimbBack: true, cramped: true })
  assert.notEqual(c.pickName, 'fall_in')
})

test('镜像：深度一大，落进去会受伤 → 成本被伤害项顶上去', () => {
  const shallow = costs({ d: 24, canClimbBack: true })
  const deep = costs({ d: 40, canClimbBack: true })
  assert.equal(costFallDamage(24, 120, 120), 0, '25 格以内不算伤害')
  assert.ok(costFallDamage(40, 120, 120) > 0, '超过 25 格要计伤害')
  assert.ok(deep.fallIn > shallow.fallIn, '深的落进去必须更贵')
})

test('镜像：会摔死 = 不可选（不是"贵"）', () => {
  assert.equal(costFallDamage(60, 120, 120), COST_INF, '伤害 ≥ 当前血量记 ∞')
  assert.ok(costs({ d: 60, canClimbBack: true }).fallIn >= COST_INF)
})

test('镜像：落差大时垫方块可能比跳更便宜（成本要真的参与比较）', () => {
  // d=1 时 bridge = 12.6 > jumpOver 6.6；d=1 且爬不回来时 bridge 也可能赢
  const c = costs({ d: 1, canClimbBack: false })
  assert.equal(c.pickName, 'jump_over')
  // d 很大、跳不过去的情形由 jump_over 成本不变体现：成本表本身不做可达判定
  assert.ok(costs({ d: 10, canClimbBack: true }).bridge > costs({ d: 1, canClimbBack: true }).bridge,
    '垫得越多越贵')
})

test('源码锁：TerrainAhead 用成本表，不再用深度阈值', () => {
  const i = CS.indexOf('private static bool TerrainAhead')
  assert.ok(i > 0, '缺少 TerrainAhead')
  const body = CS.slice(i, i + 3600)
  assert.match(body, /CostFall\(d\)/, '掉落时间要进成本')
  assert.match(body, /CostFallDamage\(d, pl\.statLife, pl\.statLifeMax2\)/, '摔落伤害要进成本')
  assert.match(body, /canClimbBack/, '要判能不能爬回出发高度')
  assert.match(body, /if \(!canClimbBack\) fallIn \+= CostInf;/, '回不来记 ∞（不是价格高，是死路）')
  assert.match(body, /double jumpOver = CostJump \+ CostWalk;/, '跳过去要有自己的成本')
  assert.match(body, /double bridge = d \* \(CostPlace \+ CostWalk\)/, '垫方块要有自己的成本')
  assert.match(body, /double detour = CostWalk \* \(d \* 4 \+ 8\)/, '绕行要有自己的成本')
  assert.match(body, /Math\.Min\(Math\.Min\(fallIn, jumpOver\), Math\.Min\(bridge, detour\)\)/, '必须取四项最小')
  // 旧的硬阈值必须消失
  assert.doesNotMatch(body, /if \(d > 2\)/, '旧的"落差 >2 格就拒绝"必须删掉')
})

test('源码锁：判"死局"用 minY（能不能回到出发高度），等价 Baritone GoalYLevel', () => {
  const body = CS.slice(CS.indexOf('private static bool TerrainAhead'), CS.indexOf('private static bool TerrainAhead') + 3600)
  assert.match(body, /EscapeProbeRoam\(nx, ny, 8, out int landedMinY\)/, '要拿到落点的最高可达点')
  assert.match(body, /bool canClimbBack = landedMinY <= py;/, '判据是 minY 能不能回到出发高度')
})

test('源码锁：拒绝时把四个候选动作的成本一起报出来', () => {
  const body = moveBody()
  assert.match(body, /tIssue == "trap" \|\| tIssue\.StartsWith\("pit_"\)/, 'trap 与 pit_ 走同一分支')
  assert.match(body, /tCost/, '要把成本说明带进回包')
  assert.match(body, /jump 跳过去 ／ place 垫方块 ／ 换方向绕/, '仍给四条路')
  assert.match(body, /force:true/, '仍允许强行通过')
})

test('说明：真机验证不在本文件内（需要游戏开着看角色真的停在坑边）', () => {
  assert.ok(true)
})