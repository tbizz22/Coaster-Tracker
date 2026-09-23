import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";
import { setHouseholdId } from "../credit-tracker.jsx";

const input = { width: "100%", boxSizing: "border-box", padding: "11px 14px", background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, color: "#fff", font: "400 14px Inter, sans-serif", outline: "none" };
const button = { width: "100%", padding: 13, background: "linear-gradient(135deg,#F6534B,#D92B23)", border: "none", borderRadius: 10, color: "#fff", font: "700 15px/1 Inter, sans-serif", cursor: "pointer", letterSpacing: ".3px", boxShadow: "0 4px 20px rgba(232,54,46,.4)" };
const linkBtn = { background: "none", border: "none", color: "#2FA8FF", cursor: "pointer", fontWeight: 600, fontSize: 13, padding: 0, fontFamily: "Inter, sans-serif" };

// Coaster track for the login backdrop: station, chain lift, big drop,
// camelback, vertical loop, airtime hill and a brake run off to the right.
const RIDE_PATH = "M -420 832 L -215 832 Q -178 832 -158 804 L 238 236 C 258 208 290 176 330 176 C 372 176 398 250 418 400 C 434 520 452 800 540 832 C 606 856 652 470 720 470 C 788 470 812 836 880 836 L 1070 836 C 1170 836 1230 776 1230 670 C 1230 560 1150 505 1110 505 C 1070 505 990 560 990 670 C 990 776 1050 836 1150 836 C 1220 836 1252 652 1302 652 C 1352 652 1372 800 1432 806 L 1760 806";

// Train physics along RIDE_PATH (px units of the 1440x900 viewBox): constant
// speed in the station and up the chain lift, then energy-based speed after
// the crest (v^2 = v0^2 + 2g*drop - friction*distance), so it slows over
// hills and the loop and flies through the valleys.
const RIDE = { gravity: 450, friction: 40, gap: 48, liftSpeed: 150, stationSpeed: 240, minSpeed: 60 };

function RideCar({ lead }) {
  return (
    <g>
      {lead
        ? <path d="M-17 -9 H10 Q22 -9 22 2 V5 H-17 Z" fill="#E8362E" stroke="#0E1016" strokeWidth="2.5" strokeLinejoin="round" />
        : <rect x="-17" y="-9" width="34" height="14" rx="5" fill="#E8362E" stroke="#0E1016" strokeWidth="2.5" />}
      {lead && <circle cx="17" cy="-1" r="3" fill="#FFC629" stroke="#0E1016" strokeWidth="1.2" />}
      <circle cx="-9" cy="7" r="3.6" fill="#FFC629" stroke="#0E1016" strokeWidth="1.5" />
      <circle cx="9" cy="7" r="3.6" fill="#FFC629" stroke="#0E1016" strokeWidth="1.5" />
      <path d="M-8 -9 L-11 -22 M-4 -9 L-1 -22 M4 -9 L1 -22 M8 -9 L11 -22" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="-6" cy="-12" r="3.6" fill="#FFFFFF" />
      <circle cx="6" cy="-12" r="3.6" fill="#FFFFFF" />
    </g>
  );
}

function CoasterRide() {
  const pathRef = useRef(null);
  const carRefs = [useRef(null), useRef(null), useRef(null)];

  useEffect(() => {
    const p = pathRef.current;
    if (!p || !p.getTotalLength) return;
    const L = p.getTotalLength(), N = Math.ceil(L);
    const X = new Float32Array(N + 1), Y = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) { const q = p.getPointAtLength(Math.min(i, L)); X[i] = q.x; Y[i] = q.y; }
    // Crest of the lift hill = highest point in the left part of the ride.
    let sCrest = 0, yCrest = Infinity;
    for (let i = 0; i < N; i++) if (X[i] < 600 && Y[i] < yCrest) { yCrest = Y[i]; sCrest = i; }

    const { gravity, friction, gap, liftSpeed, stationSpeed, minSpeed } = RIDE;
    const place = s => carRefs.forEach((r, k) => {
      const i = Math.max(0, Math.min(N - 2, Math.floor(s - k * gap)));
      const a = Math.atan2(Y[i + 2] - Y[i], X[i + 2] - X[i]) * 180 / Math.PI;
      r.current?.setAttribute("transform", `translate(${X[i]} ${Y[i]}) rotate(${a}) translate(0 -10) scale(1.35)`);
    });

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      place(sCrest * 0.6); // parked partway up the lift
      return;
    }

    let s = 0, raf, last = performance.now();
    const tick = now => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const sc = s - gap, i = Math.max(0, Math.min(N, Math.floor(sc)));
      let v;
      if (sc < sCrest) v = X[i] < -170 ? stationSpeed : liftSpeed;
      else v = Math.max(minSpeed, Math.sqrt(Math.max(0, liftSpeed * liftSpeed + 2 * gravity * (Y[i] - yCrest) - friction * (sc - sCrest))));
      s += v * dt;
      if (s - 2 * gap > N - 5) s = 0; // train left the screen: back to the station
      place(s);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <g>
      <line x1="0" y1="872" x2="1440" y2="872" stroke="#2A3042" strokeWidth="2" />
      {/* support columns */}
      <g stroke="#2A3042" strokeWidth="5" strokeLinecap="round" opacity=".9">
        <line x1="10" y1="568" x2="10" y2="872" />
        <line x1="66" y1="488" x2="66" y2="872" />
        <line x1="122" y1="407" x2="122" y2="872" />
        <line x1="178" y1="327" x2="178" y2="872" />
        <line x1="234" y1="247" x2="234" y2="872" />
        <line x1="300" y1="188" x2="300" y2="872" />
        <line x1="360" y1="197" x2="360" y2="872" />
        <line x1="650" y1="597" x2="650" y2="872" />
        <line x1="720" y1="476" x2="720" y2="872" />
        <line x1="790" y1="617" x2="790" y2="872" />
        <line x1="1302" y1="658" x2="1302" y2="872" />
        <line x1="1250" y1="716" x2="1250" y2="872" />
        <line x1="1350" y1="705" x2="1350" y2="872" />
      </g>
      {/* ties */}
      <path ref={pathRef} d={RIDE_PATH} fill="none" stroke="#3D4A5E" strokeWidth="16" strokeDasharray="3 10" />
      {/* rail */}
      <path d={RIDE_PATH} fill="none" stroke="#FFC629" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" opacity=".75" filter="url(#ct-glow)" />
      {/* chain on the lift hill */}
      <path d="M -158 804 L 238 236" fill="none" stroke="#0E1016" strokeWidth="1.6" strokeDasharray="4 5" opacity=".9" />
      {[0, 1, 2].map(k => (
        <g key={k} ref={carRefs[k]} transform="translate(-600 832)"><RideCar lead={k === 0} /></g>
      ))}
    </g>
  );
}

// Login backdrop: halftone, glow and floating comic-burst accents from the
// Coaster Attack design system. The ride itself lives in LoginRide.
function LoginBackground() {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#0E1016", overflow: "hidden" }}>
      <style>{`
        @keyframes ct-floatA{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-18px) rotate(-2deg)}}
        @keyframes ct-floatB{0%,100%{transform:translateY(0) rotate(6deg)}50%{transform:translateY(-12px) rotate(4deg)}}
        @keyframes ct-floatC{0%,100%{transform:translateY(0) rotate(-8deg)}50%{transform:translateY(-22px) rotate(-5deg)}}
      `}</style>

      {/* halftone layer */}
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: .18 }} preserveAspectRatio="xMidYMid slice">
        <defs><pattern id="ct-ht" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="2.2" fill="#FFC629" /></pattern></defs>
        <rect width="100%" height="100%" fill="url(#ct-ht)" />
      </svg>

      {/* radial glow center */}
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 60% 60% at 35% 55%,rgba(42,48,66,.9) 0%,transparent 70%)" }} />

      {/* scattered comic pop stars */}
      <div style={{ position: "absolute", top: "7%", left: "8%", animation: "ct-floatA 6s ease-in-out infinite" }}>
        <svg width="52" height="52" viewBox="0 0 52 52" opacity=".55">
          <polygon points="26,4 29.5,18 44,14 34,24 48,31 33,32 36,47 26,36 16,47 19,32 4,31 18,24 8,14 22.5,18" fill="#E8362E" stroke="#0e1016" strokeWidth="2" />
        </svg>
      </div>
      <div style={{ position: "absolute", top: "14%", right: "9%", animation: "ct-floatB 8s ease-in-out infinite" }}>
        <svg width="38" height="38" viewBox="0 0 52 52" opacity=".45">
          <polygon points="26,4 29.5,18 44,14 34,24 48,31 33,32 36,47 26,36 16,47 19,32 4,31 18,24 8,14 22.5,18" fill="#FFC629" stroke="#0e1016" strokeWidth="2" />
        </svg>
      </div>
      <div style={{ position: "absolute", bottom: "28%", left: "5%", animation: "ct-floatC 7s ease-in-out infinite" }}>
        <svg width="30" height="30" viewBox="0 0 52 52" opacity=".35">
          <polygon points="26,4 29.5,18 44,14 34,24 48,31 33,32 36,47 26,36 16,47 19,32 4,31 18,24 8,14 22.5,18" fill="#2FA8FF" stroke="#0e1016" strokeWidth="2" />
        </svg>
      </div>
      <div style={{ position: "absolute", top: "60%", right: "6%", animation: "ct-floatA 9s 2s ease-in-out infinite" }}>
        <svg width="44" height="44" viewBox="0 0 52 52" opacity=".4">
          <polygon points="26,4 29.5,18 44,14 34,24 48,31 33,32 36,47 26,36 16,47 19,32 4,31 18,24 8,14 22.5,18" fill="#E8362E" stroke="#0e1016" strokeWidth="2" />
        </svg>
      </div>
    </div>
  );
}

// The ride itself, sized to its own box: fills the left side next to the
// sign-in panel on desktop, and becomes a full-width band above it on phones.
// The track runs past the right edge of the viewBox, so the train rolls
// "into the station" behind the panel.
function LoginRide() {
  return (
    <svg viewBox="0 120 1440 780" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
      <defs>
        <filter id="ct-glow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      {/* floating accent bursts */}
      <g opacity=".22">
        <polygon points="100,180 106,200 128,200 110,214 116,236 100,222 84,236 90,214 72,200 94,200" fill="#E8362E" />
        <polygon points="1340,140 1344,154 1360,154 1347,163 1351,177 1340,168 1329,177 1333,163 1320,154 1336,154" fill="#FFC629" />
        <polygon points="60,400 64,416 82,416 68,426 72,442 60,432 48,442 52,426 38,416 56,416" fill="#2FA8FF" />
        <polygon points="1380,520 1383,532 1397,532 1386,540 1389,553 1380,545 1371,553 1374,540 1363,532 1377,532" fill="#FFC629" />
      </g>
      <CoasterRide />
    </svg>
  );
}

const LOGIN_CSS = `
  .ct-login { position: relative; z-index: 1; display: flex; min-height: 100vh; }
  .ct-login-ride { flex: 1; min-width: 0; display: flex; align-items: flex-end; }
  .ct-login-ride svg { display: block; width: 100%; height: 100%; }
  .ct-login-panel { box-sizing: border-box; width: 440px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; padding: 40px 48px;
    background: rgba(17,20,28,.94); border-left: 1px solid rgba(255,255,255,.08); box-shadow: -24px 0 64px rgba(0,0,0,.45); backdrop-filter: blur(18px); }
  .ct-login-form { width: 100%; max-width: 340px; }
  .ct-login-badge { display: block; width: 148px; height: 148px; }
  @media (max-width: 860px) {
    .ct-login { flex-direction: column; }
    .ct-login-ride { flex: none; width: 100%; aspect-ratio: 1440 / 780; }
    .ct-login-panel { flex: 1; width: auto; align-items: flex-start; padding: 0 20px 40px; border-left: none;
      border-top: 1px solid rgba(255,255,255,.08); box-shadow: 0 -16px 40px rgba(0,0,0,.4); }
    .ct-login-badge { width: 112px; height: 112px; margin-top: 24px; }
  }
`;

function AuthForm() {
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(""); setNotice(""); setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) setError(error.message);
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) setError(error.message);
        else if (!data.session) {
          // Email confirmation is required before a session is issued —
          // signUp succeeded but there's nothing else to do until the user
          // clicks the link, so say so instead of looking like a no-op.
          setNotice("Account created — check your email to confirm before signing in.");
        }
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "relative", minHeight: "100vh", overflow: "hidden" }}>
      <LoginBackground />

      <style>{LOGIN_CSS}</style>
      <div className="ct-login">
        <div className="ct-login-ride"><LoginRide /></div>
        <main className="ct-login-panel">
        <div className="ct-login-form">

          {/* logo lockup */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, marginBottom: 28 }}>
            <img className="ct-login-badge" src="/brand/logo/badge.svg" alt="Coaster Attack — Every Credit Counts" width={148} height={148} />
            <div style={{ font: "500 11px/1.3 Inter, sans-serif", color: "#6d7385", letterSpacing: ".5px" }}>Credit Tracker</div>
          </div>

          <h1 style={{ font: "700 20px/1.2 Inter, sans-serif", color: "#fff", marginBottom: 6 }}>
            {mode === "signin" ? "Sign in" : "Create household"}
          </h1>
          <p style={{ font: "400 13px/1.5 Inter, sans-serif", color: "#6d7385", marginBottom: 24 }}>Track your coaster credits</p>

          <form onSubmit={submit}>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", font: "600 12px/1 Inter, sans-serif", color: "#9298a8", letterSpacing: ".4px", marginBottom: 7 }}>Email</label>
              <input style={input} type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
            </div>

            <div style={{ marginBottom: 22 }}>
              <label style={{ display: "block", font: "600 12px/1 Inter, sans-serif", color: "#9298a8", letterSpacing: ".4px", marginBottom: 7 }}>Password</label>
              <input style={input} type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
            </div>

            {error && <div style={{ color: "#f87171", fontSize: 13, marginBottom: 14, fontFamily: "Inter, sans-serif" }}>{error}</div>}
            {notice && <div style={{ color: "#4ade80", fontSize: 13, marginBottom: 14, fontFamily: "Inter, sans-serif" }}>{notice}</div>}

            <button style={button} type="submit" disabled={busy}>
              {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create household"}
            </button>
          </form>

          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "20px 0" }}>
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.08)" }} />
            <span style={{ font: "400 11px/1 Inter, sans-serif", color: "#454b5c" }}>or</span>
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.08)" }} />
          </div>

          <p style={{ textAlign: "center", font: "400 13px/1.5 Inter, sans-serif", color: "#6d7385" }}>
            {mode === "signin" ? (
              <>New here? <button type="button" style={linkBtn} onClick={() => setMode("signup")}>Create a household account</button></>
            ) : (
              <>Already have an account? <button type="button" style={linkBtn} onClick={() => setMode("signin")}>Sign in</button></>
            )}
          </p>

        </div>
        </main>
      </div>
    </div>
  );
}

export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading, null = signed out
  const [householdReady, setHouseholdReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setHouseholdReady(false); return; }
    supabase
      .from("profiles")
      .select("default_household_id")
      .eq("user_id", session.user.id)
      .single()
      .then(({ data, error }) => {
        if (error || !data?.default_household_id) {
          console.error("No household found for user", error);
          return;
        }
        setHouseholdId(data.default_household_id);
        setHouseholdReady(true);
      });
  }, [session]);

  if (session === undefined) return null; // initial load
  if (session === null) return <AuthForm />;
  if (!householdReady) return null; // resolving household_id

  return children;
}
