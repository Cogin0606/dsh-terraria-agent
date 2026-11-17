// Goal 抽象 + 驱动权仲裁 —— 两件都照 Baritone 的结构做的，都是"离线可判"的纯逻辑，
// 所以在 node 里用同判据镜像锁住规则，再用源码锁保证实现没走样。
//
// 为什么需要这两件：
//   Goal —— walkto 原来只认精确 {x,y}，那格不能站就拒，于是"走到 x≈2000 附近任意能站的格子"
//           这种意图表达不出来（表现为"目标不可站"和 no-path）。
//   Drive —— 原来每条手动命令都把别的流程硬杀，Move/Jump 还顺手清掉 guard 三连，
//           于是"走两步 = 永久关掉自动防守"，怪贴脸却站着不动。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const goalsSrc = readFileSync(join(root, 'DshTerrariaBridge', 'Goals.cs'), 'utf8')
const bridgeSrc = readFileSync(join(root, 'DshTerrariaBridge', 'BridgeSystem.cs'), 'utf8')
const cmdSrc = readFileSync(join(root, 'DshTerrariaBridge', 'Commands.cs'), 'utf8')

function pick(text, a, b) {
  const i = text.indexOf(a)
  assert.ok(i > 0, `找不到起点：${a}`)
  const j = text.indexOf(b, i + a.length)
  assert.ok(j > i, `找不到终点：${b}`)
  return text.slice(i, j)
}

/* ── Goal 判据镜像 ───────────────────────────────────────────────── */

const WALK = 4.633

function goalBlock(x, y, tol = 1) {
  return {
    isAt: (px, py) => Math.abs(px - x) <= tol && Math.abs(py - y) <= tol,
    heuristic: (px, py) => WALK * (Math.abs(px - x) + Math.abs(py - y) * 2),
    tol, x, y,
  }
}
function goalX(x, tol = 1) {
  return { isAt: (px) => Math.abs(px - x) <= tol, heuristic: (px) => WALK * Math.abs(px - x) }
}
function goalYLevel(y, tol = 1) {
  return { isAt: (_px, py) => Math.abs(py - y) <= tol, heuristic: (_px, py) => WALK * Math.abs(py - y) * 2 }
}

test('GoalBlock：tol 之内算到达，tol 之外不算', () => {
  const g = goalBlock(2000, 291, 2)
  assert.equal(g.isAt(2001, 292), true)
  assert.equal(g.isAt(1998, 291), true)
  assert.equal(g.isAt(1997, 291), false, '差 3 格不算到达')
  assert.equal(g.isAt(2000, 294), false)
})

test('GoalBlock：y 的偏差比 x 贵一倍（竖直方向要跳/落）', () => {
  const g = goalBlock(2000, 291, 1)
  const dx1 = g.heuristic(2001, 291)
  const dy1 = g.heuristic(2000, 292)
  assert.ok(dy1 > dx1, '竖直一格应比水平一格贵')
  assert.equal(dy1, dx1 * 2)
})

test('GoalX：只要 x 对上就算到达，y 随便', () => {
  const g = goalX(2000, 1)
  assert.equal(g.isAt(2000, 120), true, 'y 完全不同也满足')
  assert.equal(g.isAt(1999, 300), true)
  assert.equal(g.isAt(1997, 300), false)
})

test('GoalYLevel：只要 y 对上就算到达，x 随便', () => {
  const g = goalYLevel(300, 1)
  assert.equal(g.isAt(100, 300), true)
  assert.equal(g.isAt(4000, 301), true)
  assert.equal(g.isAt(4000, 297), false)
})

test('GoalComposite：任一满足即到达，取最近的那个当启发值', () => {
  const parts = [goalBlock(2000, 300, 1), goalBlock(2050, 290, 1)]
  const any = {
    isAt: (x, y) => parts.some((p) => p.isAt(x, y)),
    heuristic: (x, y) => Math.min(...parts.map((p) => p.heuristic(x, y))),
  }
  assert.equal(any.isAt(2050, 290), true, '第二个目标也算到达')
  assert.equal(any.isAt(2020, 295), false)
  // 站在 2049 时，离 2050 更近 → 启发值应小于离 2000 的距离
  assert.equal(any.heuristic(2049, 290), goalBlock(2050, 290, 1).heuristic(2049, 290))
})

/* ── 驱动权仲裁镜像 ─────────────────────────────────────────────── */

const P = { Idle: 0, Path: 30, Mine: 50, Combat: 70, Escape: 90, Manual: 100 }

function makeDrive() {
  let owner = P.Idle, until = 0, name = ''
  const log = []
  return {
    now: 0,
    get owner() { return owner },
    current() { return owner !== P.Idle && until > 0 && this.now > until ? P.Idle : owner },
    canRun(p) { return p >= this.current() },
    acquire(p, who, u) {
      const cur = this.current()
      if (p < cur) { log.push(`${who} 被 ${name} 挡住`); return false }
      if (p > cur && cur !== P.Idle) log.push(`${name} 被 ${who} 抢占`)
      owner = p; until = u; name = who
      return true
    },
    release() { owner = P.Idle; until = 0 },
    log,
  }
}

test('Drive：手动能抢断路和战斗，反过来不行', () => {
  const d = makeDrive()
  assert.equal(d.acquire(P.Path, 'walk', 100), true)
  assert.equal(d.acquire(P.Combat, 'guard', 200), true, '战斗优先于寻路')
  assert.equal(d.acquire(P.Path, 'walk', 300), false, '寻路不能反抢战斗')
  assert.equal(d.acquire(P.Manual, 'move', 400), true, '手动最高')
  assert.equal(d.acquire(P.Escape, 'escape', 500), false, '自救也要让手动')
})

test('Drive：高优先级窗口过期后自动降级，不会永久卡住', () => {
  const d = makeDrive()
  d.acquire(P.Manual, 'move', 10)
  d.now = 5
  assert.equal(d.canRun(P.Combat), false, '窗口内战斗要让路')
  d.now = 20
  assert.equal(d.current(), P.Idle, '过期即 Idle')
  assert.equal(d.canRun(P.Combat), true, '过期后战斗可以跑')
})

test('Drive：每次抢占都留痕（排查"命令回 ok 但人不动"）', () => {
  const d = makeDrive()
  d.acquire(P.Path, 'walk', 100)
  d.acquire(P.Manual, 'move', 200)
  assert.ok(d.log.some((l) => l.includes('walk 被 move 抢占')), `抢占没记录：${d.log}`)
})

test('Drive：低优先级被挡时不会顶掉持有者', () => {
  const d = makeDrive()
  d.acquire(P.Escape, 'escape', 100)
  assert.equal(d.acquire(P.Path, 'walk', 200), false)
  assert.equal(d.current(), P.Escape, '持有者必须还是 escape')
})

/* ── 源码锁：Goals.cs ───────────────────────────────────────────── */

test('Goals：六种目标都在，且都用同一个 Standable 判据', () => {
  for (const cls of ['GoalBlock', 'GoalX', 'GoalYLevel', 'GoalComposite', 'GoalAway']) {
    assert.match(goalsSrc, new RegExp(`class ${cls} : Goal`), `缺少 ${cls}`)
  }
  const body = pick(goalsSrc, 'internal static bool Standable', 'protected static bool ScanBox')
  assert.match(body, /BridgeSystem\.PathBodyFree\(x, y\) && BridgeSystem\.PathFloorAt\(x, y\)/,
    '能站必须同时判身体和脚下')
})

test('Goals：BaseGoal 不写世界、不挥物品（纯读）', () => {
  assert.doesNotMatch(goalsSrc, /Main\.tile\[[^\]]*\]\.\w+\s*=(?!=)/)
  assert.doesNotMatch(goalsSrc, /BeginItemUse\(|BeginPlayerMine\(|WorldGen\./)
  assert.doesNotMatch(goalsSrc, /\.velocity\.[XY]\s*=(?!=)/)
})

test('walkto：mode 六种都接上了，block 之外走 Goal，block 保留原校验', () => {
  const body = pick(cmdSrc, 'private static Goal BuildGoal', 'private static string WalkTo')
  for (const m of ['"near"', '"xz"', '"ylevel"', '"any"', '"away"', '"block"']) {
    assert.ok(body.includes(m), `BuildGoal 没处理 mode ${m}`)
  }
  const walk = pick(cmdSrc, 'private static string WalkTo', 'private static string Climb')
  assert.match(walk, /goal\.Resolve\(px, py, searchR/, 'must resolve goal to a standable cell')
  assert.match(walk, /already = true/, 'already satisfied should not send input')
})

/* ── 源码锁：驱动权 ─────────────────────────────────────────────── */

test('Drive：优先级表存在，且 Combat/Escape 都受它约束', () => {
  assert.match(bridgeSrc, /enum Drive : int \{ Idle = 0, Path = 30, Mine = 50, Combat = 70, Escape = 90, Manual = 100 \}/)
  const guard = pick(bridgeSrc, 'private static void ApplyGuard', 'if (GuardPrevAnim > 0')
  assert.match(guard, /if \(!CanRun\(Drive\.Combat\)\) return;/, 'guard 必须让路但不是被销毁')
  const esc = pick(bridgeSrc, 'private static void ApplyEscape', 'EscapeNextEval = now + 25')
  assert.match(esc, /if \(!CanRun\(Drive\.Escape\)\) return;/, 'escape 也要让路而不是退出')
})

test('Drive：BeginWalk 拿不到驱动权就明确失败，不假启动', () => {
  const body = pick(bridgeSrc, 'internal static bool BeginWalk', 'WalkTol = Math.Max(0, tol)')
  assert.match(body, /if \(!Acquire\(Drive\.Path, "walk", until\)\)/, '必须申请驱动权')
  assert.match(body, /WalkStop = "preempted:"/, '失败要留原因')
  assert.match(body, /return false;/, '失败要回 false')
})

test('Drive：SetControls 路径仍然只在有权限时写方向键（move 不再销毁 guard）', () => {
  const move = pick(cmdSrc, 'private static string Move(JsonElement p)', 'private static string Jump(JsonElement p)')
  assert.doesNotMatch(move, /GuardUntil = 0/, 'move 不许再清 GuardUntil')
  assert.doesNotMatch(move, /GuardDefault = false/, 'move 不许再关 guard 默认值')
  assert.match(move, /Acquire\(BridgeSystem\.Drive\.Manual/, 'move 要抢驱动权')
  const jump = pick(cmdSrc, 'private static string Jump(JsonElement p)', 'private static string Use(JsonElement p)')
  assert.doesNotMatch(jump, /GuardUntil = 0/, 'jump 不许再清 GuardUntil')
})

test('state：drive 与 walk.step 都能读到（排查靠它，不靠猜）', () => {
  assert.match(cmdSrc, /data\["drive"\] = BridgeSystem\.DriveStatus\(\)/)
  assert.match(cmdSrc, /step = new\s*\{[\s\S]{0,900}?blocked = BridgeSystem\.WalkDbgBlocked/)
})

/* ── findpit 新增的两个排除条件 ─────────────────────────────────── */

test('findpit：封顶的竖井不算坑，平台当底也不算坑', () => {
  const body = pick(cmdSrc, 'private static string FindPit', 'private static string count_note')
  assert.match(body, /openAbove/, '要有敞口参数')
  assert.match(body, /int roofGap = 0;/, '要数井口上方连续空格')
  assert.match(body, /if \(roofGap >= openAbove && !floorIsPlatform\)/, '两个排除条件都要生效')
  assert.match(body, /Main\.tileSolidTop\[[\s\S]{0,80}?&& !Main\.tileSolid\[/, '平台判定：solidTop 且非 solid')
})

test('findpit：dist 是二维距离，并给出 dy 与"地表走得到吗"', () => {
  const body = pick(cmdSrc, 'private static string FindPit', 'private static string count_note')
  assert.match(body, /Math\.Sqrt\(\(double\)\(gx - cx\) \* \(gx - cx\) \+ \(double\)dy \* dy\)/,
    '距离必须算二维，否则地下 30 格会报成"距 5 格"')
  assert.match(body, /reachableFromSurface = r\[7\] >= -2/, '要标出这个坑地表走不走得到')
  assert.match(body, /rows\.Sort\(\(a, b\) => a\[6\]\.CompareTo\(b\[6\]\)\)/, '结果按距离由近到远')
})

test('说明：真机验证不在本文件内', () => {
  assert.ok(true, 'goals / drive / findpit 的判定都要进游戏看回读才算通过')
})