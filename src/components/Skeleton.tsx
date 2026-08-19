/**
 * Skeleton — grey shimmer placeholders shown while a page loads its data.
 * Keeps the layout stable so content doesn't "jump" in. Teal-tinted shimmer.
 */

function SkeletonBox({ width = '100%', height = 16, radius = 6, style }: { width?: number | string; height?: number | string; radius?: number; style?: React.CSSProperties }) {
    return (
        <span
            style={{
                display: 'inline-block', width, height, borderRadius: radius,
                background: 'linear-gradient(90deg, #e4eeec 25%, #f1f7f6 50%, #e4eeec 75%)',
                backgroundSize: '200% 100%',
                animation: 'dm-shimmer 1.3s ease-in-out infinite',
                ...style,
            }}
        />
    );
}

/** A skeleton matching a firm card (collapsed). */
export function SkeletonCard() {
    return (
        <div className="card" style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <SkeletonBox width={18} height={18} radius={4} />
            <div style={{ flex: 1 }}>
                <SkeletonBox width={160} height={15} />
                <div style={{ marginTop: 6 }}><SkeletonBox width={100} height={12} /></div>
            </div>
            <SkeletonBox width={70} height={20} />
        </div>
    );
}

/** Stylesheet (mount once). */
export function SkeletonStyles() {
    return <style>{`@keyframes dm-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>;
}
