/**
 * Logo — the DeliveryManager mark: a rounded teal badge with an orange freight
 * truck, designed to pop on dark backgrounds. Used in the splash and sidebar,
 * and is the source design for the app .ico icon.
 *
 * `size` controls the badge square; `glow` adds the outer shadow (splash/dark use).
 */
export default function Logo({ size = 90, glow = false, radiusRatio = 0.27 }: { size?: number; glow?: boolean; radiusRatio?: number }) {
  const r = Math.round(size * radiusRatio);
  return (
    <div
      style={{
        width: size, height: size, borderRadius: r,
        background: 'linear-gradient(145deg, #1fb6ba, #144D52)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: glow ? '0 0 28px rgba(31,182,186,0.55)' : 'none',
        flexShrink: 0,
      }}
    >
      <svg width={size * 0.58} height={size * 0.4} viewBox="0 0 48 34" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="6" width="26" height="18" rx="2" fill="#E66C32" />
        <path d="M27 11 H37 L45 18 V24 H27 Z" fill="#fde68a" />
        <rect x="29" y="13" width="7" height="5" rx="1" fill="#144D52" />
        <circle cx="9" cy="26" r="4" fill="#fff" />
        <circle cx="38" cy="26" r="4" fill="#fff" />
      </svg>
    </div>
  );
}
