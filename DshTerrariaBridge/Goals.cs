using System;
using System.Collections.Generic;

namespace DshTerrariaBridge
{
    /// <summary>
    /// 目标抽象，结构照 Baritone 的 Goal 家族（GoalBlock / GoalNear / GoalXZ / GoalYLevel /
    /// GoalComposite / GoalInverted）。为什么需要它：walkto 原先只接受精确 {x,y}，
    /// 那一格不能站就直接拒绝并给个"最近可站"的建议，于是"走到 x≈2000 附近任意能站的格子"
    /// 这种最常见的意图根本表达不出来，表现出来就是"目标不可站"和 no-path。
    ///
    /// 设计要点：Goal 只回答"到没到""还差多远"，**不负责走路**；
    /// Resolve 把它落成一个真的能站的格子，再交给已有的 A*。这样寻路一行不用改。
    /// 所有方法都是纯读，不写任何状态。
    /// </summary>
    internal abstract class Goal
    {
        /// <summary>一格平地的行走成本，与 Commands 里的 CostWalk 同一个数（Baritone WALK_ONE_BLOCK_COST）。</summary>
        protected const double WalkCost = 4.633;

        /// <summary>(x,y) 这个格本身就满足目标吗。</summary>
        public abstract bool IsAt(int x, int y);

        /// <summary>从 (x,y) 到目标的估计代价，只用于在多个候选中挑最近的。</summary>
        public abstract double Heuristic(int x, int y);

        /// <summary>给回包看的描述，例如 "near(2000,291,tol=3)"。</summary>
        public abstract string Describe();

        /// <summary>
        /// 找一个满足本目标、且真的能站的格子。搜索窗口由实现自己决定，
        /// 但必须落在 (cx,cy) 的可达范围附近 —— 找到的格子会直接交给 A*，太远就是另一回事了。
        /// </summary>
        public abstract bool Resolve(int cx, int cy, int searchR, out int tx, out int ty);

        /// <summary>能站 = 身体放得下 + 脚下一格之内有地板（平台/半砖都算）。</summary>
        internal static bool Standable(int x, int y)
            => BridgeSystem.PathBodyFree(x, y) && BridgeSystem.PathFloorAt(x, y);

        /// <summary>在矩形里扫所有可站格，用 pick 挑一个；pick 返回 true 表示"就它了"。</summary>
        protected static bool ScanBox(int x0, int y0, int x1, int y1, Func<int, int, double> score,
                                      out int bx, out int by)
        {
            bx = int.MinValue; by = int.MinValue;
            double best = double.MaxValue;
            for (int y = y0; y <= y1; y++)
            {
                for (int x = x0; x <= x1; x++)
                {
                    if (!Standable(x, y)) continue;
                    double s = score(x, y);
                    if (s < best) { best = s; bx = x; by = y; }
                }
            }
            return bx != int.MinValue;
        }
    }

    /// <summary>精确到某一格（Baritone GoalBlock）。位置必须完全对上，回退到 tol 内最近的可站格。</summary>
    internal sealed class GoalBlock : Goal
    {
        public readonly int X, Y, Tol;
        public GoalBlock(int x, int y, int tol = 1) { X = x; Y = y; Tol = Math.Max(0, tol); }

        public override bool IsAt(int x, int y) => Math.Abs(x - X) <= Tol && Math.Abs(y - Y) <= Tol;
        public override double Heuristic(int x, int y) => WalkCost * (Math.Abs(x - X) + Math.Abs(y - Y) * 2);
        public override string Describe() => $"block({X},{Y},tol={Tol})";

        public override bool Resolve(int cx, int cy, int searchR, out int tx, out int ty)
            => ScanBox(X - Tol, Y - Tol, X + Tol, Y + Tol,
                       (x, y) => Math.Abs(x - cx) + Math.Abs(y - cy), out tx, out ty);
    }

    /// <summary>只要 x 对上，y 随便（Baritone GoalXZ 的一维版）。"往这个方向走几十格"用它。</summary>
    internal sealed class GoalX : Goal
    {
        public readonly int X, Tol;
        public GoalX(int x, int tol = 1) { X = x; Tol = Math.Max(0, tol); }

        public override bool IsAt(int x, int y) => Math.Abs(x - X) <= Tol;
        public override double Heuristic(int x, int y) => WalkCost * Math.Abs(x - X);
        public override string Describe() => $"x({X},tol={Tol})";

        public override bool Resolve(int cx, int cy, int searchR, out int tx, out int ty)
            => ScanBox(X - Tol, cy - searchR, X + Tol, cy + searchR,
                       (x, y) => Math.Abs(y - cy) + Math.Abs(x - cx) * 0.1, out tx, out ty);
    }

    /// <summary>只要 y 对上，x 随便（Baritone GoalYLevel）。"回到地面那层"用它。</summary>
    internal sealed class GoalYLevel : Goal
    {
        public readonly int Y, Tol;
        public GoalYLevel(int y, int tol = 1) { Y = y; Tol = Math.Max(0, tol); }

        public override bool IsAt(int x, int y) => Math.Abs(y - Y) <= Tol;
        public override double Heuristic(int x, int y) => WalkCost * Math.Abs(y - Y) * 2;
        public override string Describe() => $"ylevel({Y},tol={Tol})";

        public override bool Resolve(int cx, int cy, int searchR, out int tx, out int ty)
            => ScanBox(cx - searchR, Y - Tol, cx + searchR, Y + Tol,
                       (x, y) => Math.Abs(x - cx), out tx, out ty);
    }

    /// <summary>多个目标任一满足，最近的赢（Baritone GoalComposite）。</summary>
    internal sealed class GoalComposite : Goal
    {
        private readonly List<Goal> parts;
        public GoalComposite(IEnumerable<Goal> goals) { parts = new List<Goal>(goals); }

        public int Count => parts.Count;

        public override bool IsAt(int x, int y)
        {
            foreach (Goal g in parts) if (g.IsAt(x, y)) return true;
            return false;
        }

        public override double Heuristic(int x, int y)
        {
            double best = double.MaxValue;
            foreach (Goal g in parts) best = Math.Min(best, g.Heuristic(x, y));
            return best;
        }

        public override string Describe()
        {
            var names = new List<string>();
            foreach (Goal g in parts) names.Add(g.Describe());
            return "any[" + string.Join(" | ", names) + "]";
        }

        public override bool Resolve(int cx, int cy, int searchR, out int tx, out int ty)
        {
            tx = int.MinValue; ty = int.MinValue;
            double best = double.MaxValue;
            foreach (Goal g in parts)
            {
                if (!g.Resolve(cx, cy, searchR, out int px, out int py)) continue;
                double s = Math.Abs(px - cx) + Math.Abs(py - cy);
                if (s < best) { best = s; tx = px; ty = py; }
            }
            return tx != int.MinValue;
        }
    }

    /// <summary>
    /// 远离某点（Baritone GoalInverted / GoalRunAway）。不是找"到哪"，是找"离它最远的可站格"，
    /// 所以 Resolve 挑的是 score 最大的那个；离得不够远就返回 false（没有满足的落脚点）。
    /// </summary>
    internal sealed class GoalAway : Goal
    {
        public readonly int X, Y, MinDist;
        public GoalAway(int x, int y, int minDist) { X = x; Y = y; MinDist = Math.Max(1, minDist); }

        public override bool IsAt(int x, int y) => Dist(x, y) >= MinDist;
        public override double Heuristic(int x, int y) => -WalkCost * Dist(x, y);   // 越远越好
        public override string Describe() => $"away({X},{Y},min={MinDist})";

        private int Dist(int x, int y) => (int)Math.Round(Math.Sqrt((x - X) * (x - X) + (y - Y) * (y - Y)));

        public override bool Resolve(int cx, int cy, int searchR, out int tx, out int ty)
        {
            tx = int.MinValue; ty = int.MinValue;
            int best = MinDist - 1;
            for (int y = cy - searchR; y <= cy + searchR; y++)
            {
                for (int x = cx - searchR; x <= cx + searchR; x++)
                {
                    if (!Standable(x, y)) continue;
                    int d = Dist(x, y);
                    if (d > best) { best = d; tx = x; ty = y; }
                }
            }
            return tx != int.MinValue;
        }
    }
}