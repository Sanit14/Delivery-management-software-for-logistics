/**
 * SplashScreen — choreographed cinematic startup.
 *
 * Timeline (single synced sequence, ~2.4s):
 *   0.0–0.6s  title fades/settles in at top
 *   0.4–2.0s  truck appears as distant headlights at the horizon vanishing point,
 *             then drives the endless road toward the viewer, accelerating
 *   2.0–2.4s  whole scene lunges forward + fades → hands off to dashboard
 *
 * Endless road: a perspective plane that FADES into a glowing horizon (no hard cut).
 * Pure CSS, full-window, dark base so it pops like a logo on a black wallpaper.
 */
import Logo from './Logo';

export default function SplashScreen() {  return (
    <div className="dm-splash">
      {/* depth: dark sky with a teal horizon glow */}
      <div className="dm-sky" />
      <div className="dm-horizon-glow" />

      {/* endless perspective road that fades into the horizon */}
      <div className="dm-road">
        <div className="dm-road-surface" />
        <div className="dm-road-lines" />
        <div className="dm-road-fade" />
      </div>

      {/* brand */}
      <div className="dm-brand">
        <div className="dm-logo-badge"><Logo size={70} glow /></div>
        <div className="dm-title">DeliveryManager</div>
        <div className="dm-sub">Sundeep Freight Movers</div>
      </div>

      {/* distant headlights that resolve into the truck */}
      <div className="dm-truck">
        <TruckFront />
      </div>

      <style>{`
        .dm-splash {
          position: fixed; inset: 0; z-index: 9999; overflow: hidden;
          background: #07181a;
          font-family: 'Plus Jakarta Sans', sans-serif;
          animation: dm-handoff 2.4s cubic-bezier(0.7, 0, 0.84, 0) forwards;
        }
        /* the whole scene accelerates forward at the end and fades into the app */
        @keyframes dm-handoff {
          0%, 80%  { transform: scale(1);    opacity: 1; }
          100%     { transform: scale(1.6);  opacity: 0; }
        }

        .dm-sky {
          position: absolute; inset: 0;
          background: radial-gradient(120% 80% at 50% 62%, #16777b 0%, #0d3a3e 38%, #07181a 75%);
        }
        /* glowing vanishing point on the horizon */
        .dm-horizon-glow {
          position: absolute; left: 50%; top: 58%; transform: translate(-50%, -50%);
          width: 260px; height: 120px;
          background: radial-gradient(ellipse, rgba(253,230,138,0.45), rgba(29,150,153,0.15) 45%, transparent 70%);
          filter: blur(6px);
          animation: dm-horizon-pulse 2.4s ease-in-out;
        }
        @keyframes dm-horizon-pulse { 0% { opacity: 0.5; } 70% { opacity: 0.9; } 100% { opacity: 1; } }

        /* ---- endless road ---- */
        .dm-road {
          position: absolute; left: 0; right: 0; bottom: 0; top: 58%;
          perspective: 360px; perspective-origin: 50% 0%;
        }
        .dm-road-surface {
          position: absolute; inset: 0;
          background: linear-gradient(180deg, #0a2a2d 0%, #103438 100%);
          transform: rotateX(64deg); transform-origin: 50% 0%;
        }
        .dm-road-lines {
          position: absolute; left: 50%; top: 0; bottom: 0; width: 12px; margin-left: -6px;
          background: repeating-linear-gradient(180deg, #fde68a 0 30px, transparent 30px 72px);
          background-size: 100% 102px;
          transform: rotateX(64deg); transform-origin: 50% 0%;
          animation: dm-road-move 0.45s linear infinite;
          -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 24%, #000 100%);
                  mask-image: linear-gradient(180deg, transparent 0%, #000 24%, #000 100%);
        }
        @keyframes dm-road-move { to { background-position-y: 102px; } }
        /* soft fade where the road meets the horizon — no hard cut, feels endless */
        .dm-road-fade {
          position: absolute; left: 0; right: 0; top: 0; height: 38%;
          background: linear-gradient(180deg, #07181a 0%, rgba(13,58,62,0.6) 50%, transparent 100%);
        }

        /* ---- brand ---- */
        .dm-brand {
          position: absolute; top: 16%; left: 0; right: 0; text-align: center;
          animation: dm-brand-in 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        .dm-logo-badge { display: flex; justify-content: center; margin-bottom: 18px; }
        .dm-title {
          font-size: 38px; font-weight: 800; letter-spacing: 0.5px;
          color: #fff; text-shadow: 0 2px 20px rgba(29,150,153,0.6);
        }
        .dm-sub {
          font-size: 13px; font-weight: 600; margin-top: 8px;
          letter-spacing: 4px; text-transform: uppercase; color: #fde68a;
        }
        @keyframes dm-brand-in {
          0%   { opacity: 0; transform: translateY(-16px); filter: blur(4px); }
          100% { opacity: 1; transform: translateY(0); filter: blur(0); }
        }

        /* ---- truck: starts as a far speck at the vanishing point, drives toward viewer ---- */
        .dm-truck {
          position: absolute; left: 50%; top: 56%;
          transform-origin: center center;
          animation: dm-truck-approach 2.4s cubic-bezier(0.55, 0, 0.9, 0.55) forwards;
          filter: drop-shadow(0 12px 14px rgba(0,0,0,0.5));
        }
        @keyframes dm-truck-approach {
          0%   { transform: translate(-50%, -50%) scale(0.04); opacity: 0; }
          12%  { transform: translate(-50%, -46%) scale(0.07); opacity: 1; }
          45%  { transform: translate(-50%, -20%) scale(0.26); opacity: 1; }
          72%  { transform: translate(-50%, 30%)  scale(0.62); opacity: 1; }
          100% { transform: translate(-50%, 150%) scale(1.5);  opacity: 1; }
        }
      `}</style>
    </div>
  );
}

/* Head-on freight truck with glowing headlights */
function TruckFront() {
  return (
    <svg width="150" height="120" viewBox="0 0 150 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
      <defs>
        <radialGradient id="dm-hl" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fffbe6" />
          <stop offset="100%" stopColor="#fff7d6" stopOpacity="0.2" />
        </radialGradient>
      </defs>
      {/* headlight beams (glow) */}
      <ellipse cx="34" cy="86" rx="16" ry="10" fill="url(#dm-hl)" opacity="0.55" />
      <ellipse cx="116" cy="86" rx="16" ry="10" fill="url(#dm-hl)" opacity="0.55" />
      {/* trailer */}
      <rect x="28" y="14" width="94" height="70" rx="6" fill="#cf5e2a" />
      <rect x="34" y="20" width="82" height="58" rx="4" fill="#E66C32" />
      {/* cab */}
      <rect x="22" y="40" width="106" height="58" rx="8" fill="#fde68a" />
      <rect x="22" y="40" width="106" height="20" rx="8" fill="#ffe9a8" />
      {/* windshield */}
      <rect x="34" y="48" width="82" height="26" rx="5" fill="#0d3a3e" />
      <rect x="38" y="52" width="74" height="9" rx="3" fill="#1D9699" opacity="0.7" />
      {/* grille */}
      <rect x="46" y="80" width="58" height="10" rx="3" fill="#16323b" />
      {/* headlights */}
      <circle cx="34" cy="86" r="6" fill="#fffbe6" />
      <circle cx="116" cy="86" r="6" fill="#fffbe6" />
      {/* bumper + wheels */}
      <rect x="20" y="94" width="110" height="8" rx="4" fill="#0d3a3e" />
      <rect x="20" y="98" width="20" height="16" rx="5" fill="#16323b" />
      <rect x="110" y="98" width="20" height="16" rx="5" fill="#16323b" />
      {/* mirrors */}
      <rect x="12" y="56" width="10" height="16" rx="3" fill="#cf5e2a" />
      <rect x="128" y="56" width="10" height="16" rx="3" fill="#cf5e2a" />
    </svg>
  );
}
