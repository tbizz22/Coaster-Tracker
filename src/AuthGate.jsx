import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import { setHouseholdId } from "../credit-tracker.jsx";

const input = { width: "100%", boxSizing: "border-box", padding: "11px 14px", background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, color: "#fff", font: "400 14px Inter, sans-serif", outline: "none" };
const button = { width: "100%", padding: 13, background: "linear-gradient(135deg,#F6534B,#D92B23)", border: "none", borderRadius: 10, color: "#fff", font: "700 15px/1 Inter, sans-serif", cursor: "pointer", letterSpacing: ".3px", boxShadow: "0 4px 20px rgba(232,54,46,.4)" };
const linkBtn = { background: "none", border: "none", color: "#2FA8FF", cursor: "pointer", fontWeight: 600, fontSize: 13, padding: 0, fontFamily: "Inter, sans-serif" };

// Background lifted from the Coaster Attack design system (login background
// .dc.html) — an animated track + car loop with floating comic-burst accents,
// kept purely decorative behind the auth card.
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
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 70% 60% at 50% 50%,rgba(42,48,66,.95) 0%,transparent 70%)" }} />

      {/* track + car */}
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        <defs>
          <filter id="ct-glow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <filter id="ct-carGlow"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>

        {/* speed lines */}
        <g stroke="rgba(255,255,255,.06)" strokeWidth="1.5" strokeLinecap="round">
          <line x1="720" y1="450" x2="0" y2="200" /><line x1="720" y1="450" x2="0" y2="450" />
          <line x1="720" y1="450" x2="0" y2="680" /><line x1="720" y1="450" x2="300" y2="0" />
          <line x1="720" y1="450" x2="720" y2="0" /><line x1="720" y1="450" x2="1140" y2="0" />
          <line x1="720" y1="450" x2="1440" y2="200" /><line x1="720" y1="450" x2="1440" y2="450" />
          <line x1="720" y1="450" x2="1440" y2="680" /><line x1="720" y1="450" x2="300" y2="900" />
          <line x1="720" y1="450" x2="720" y2="900" /><line x1="720" y1="450" x2="1140" y2="900" />
        </g>

        {/* tie marks */}
        <g stroke="#2A3042" strokeWidth="14" strokeLinecap="round" opacity=".9">
          <line x1="60" y1="640" x2="60" y2="628" /><line x1="120" y1="596" x2="126" y2="584" />
          <line x1="180" y1="558" x2="191" y2="548" /><line x1="240" y1="524" x2="253" y2="517" />
          <line x1="300" y1="497" x2="315" y2="492" /><line x1="360" y1="478" x2="376" y2="477" />
          <line x1="418" y1="470" x2="434" y2="472" /><line x1="474" y1="475" x2="489" y2="481" />
          <line x1="528" y1="496" x2="538" y2="506" /><line x1="570" y1="524" x2="576" y2="537" />
          <line x1="598" y1="557" x2="600" y2="572" /><line x1="612" y1="590" x2="610" y2="605" />
          <line x1="614" y1="622" x2="608" y2="637" /><line x1="606" y1="652" x2="596" y2="665" />
          <line x1="591" y1="676" x2="578" y2="686" /><line x1="566" y1="693" x2="551" y2="700" />
          <line x1="536" y1="703" x2="520" y2="706" /><line x1="504" y1="706" x2="488" y2="704" />
          <line x1="473" y1="699" x2="458" y2="692" /><line x1="444" y1="683" x2="431" y2="673" />
          <line x1="419" y1="661" x2="409" y2="649" /><line x1="399" y1="636" x2="392" y2="622" />
          <line x1="387" y1="608" x2="383" y2="594" /><line x1="381" y1="580" x2="380" y2="566" />
          <line x1="381" y1="552" x2="383" y2="538" /><line x1="388" y1="524" x2="394" y2="511" />
          <line x1="402" y1="499" x2="411" y2="487" /><line x1="422" y1="477" x2="434" y2="467" />
          <line x1="448" y1="460" x2="461" y2="453" /><line x1="476" y1="449" x2="491" y2="446" />
          <line x1="507" y1="444" x2="522" y2="445" /><line x1="537" y1="447" x2="552" y2="452" />
          <line x1="566" y1="458" x2="579" y2="466" /><line x1="591" y1="475" x2="602" y2="486" />
          <line x1="612" y1="498" x2="619" y2="512" /><line x1="624" y1="526" x2="627" y2="542" />
          <line x1="628" y1="556" x2="626" y2="572" /><line x1="622" y1="586" x2="616" y2="600" />
          <line x1="777" y1="148" x2="791" y2="142" /><line x1="834" y1="138" x2="849" y2="136" />
          <line x1="891" y1="138" x2="906" y2="142" /><line x1="944" y1="153" x2="957" y2="161" />
          <line x1="992" y1="178" x2="1002" y2="189" /><line x1="1032" y1="208" x2="1039" y2="221" />
          <line x1="1060" y1="241" x2="1063" y2="255" /><line x1="1074" y1="275" x2="1074" y2="289" />
          <line x1="1072" y1="309" x2="1069" y2="323" /><line x1="1061" y1="341" x2="1054" y2="354" />
          <line x1="1040" y1="369" x2="1031" y2="380" /><line x1="1014" y1="391" x2="1002" y2="399" />
          <line x1="986" y1="404" x2="973" y2="407" /><line x1="958" y1="407" x2="945" y2="404" />
          <line x1="930" y1="398" x2="919" y2="390" /><line x1="908" y1="380" x2="900" y2="368" />
          <line x1="895" y1="354" x2="894" y2="340" /><line x1="896" y1="326" x2="901" y2="313" />
          <line x1="910" y1="300" x2="920" y2="290" /><line x1="933" y1="283" x2="946" y2="279" />
          <line x1="959" y1="278" x2="972" y2="280" /><line x1="984" y1="285" x2="995" y2="293" />
          <line x1="1003" y1="303" x2="1008" y2="315" />
          <line x1="1120" y1="440" x2="1136" y2="442" /><line x1="1190" y1="464" x2="1204" y2="472" />
          <line x1="1246" y1="505" x2="1254" y2="520" /><line x1="1282" y1="554" x2="1284" y2="570" />
          <line x1="1302" y1="608" x2="1298" y2="623" /><line x1="1308" y1="658" x2="1298" y2="670" />
          <line x1="1296" y1="712" x2="1283" y2="720" /><line x1="1361" y1="820" x2="1375" y2="818" />
          <line x1="1416" y1="850" x2="1430" y2="844" />
        </g>

        {/* main coaster path — outer rail */}
        <path id="ct-trackPath"
          d="M0,650 C60,650 100,560 180,540 C260,520 340,470 440,468 C520,467 560,530 590,590 C615,640 608,700 560,716 C510,732 455,706 430,660 C405,614 410,555 440,520 C470,485 500,452 540,450 C580,448 610,475 630,510 C650,545 628,610 640,640 C652,612 680,540 730,430 C780,320 730,195 800,148 C860,108 940,130 990,180 C1040,230 1075,300 1070,370 C1065,420 1030,405 975,408 C920,411 885,370 890,320 C895,275 945,270 980,288 C1015,306 1020,350 1008,375 C1050,380 1120,424 1180,465 C1240,506 1280,580 1300,650 C1316,700 1302,760 1280,810 C1320,810 1380,836 1440,860"
          fill="none" stroke="#E8362E" strokeWidth="6" strokeLinecap="round" filter="url(#ct-glow)" opacity=".8" />
        {/* inner rail */}
        <path
          d="M0,638 C60,638 100,548 178,528 C258,508 338,460 438,459 C516,458 556,520 585,579 C608,628 601,687 553,703 C503,719 449,694 425,649 C401,603 406,546 436,511 C466,476 496,444 535,442 C574,440 602,466 622,501 C641,534 619,598 631,628 C643,600 671,528 721,419 C771,310 721,186 793,140 C852,100 930,122 980,170 C1028,218 1063,288 1058,358 C1053,408 1018,393 963,396 C908,399 873,360 878,312 C883,267 932,261 967,278 C1002,295 1007,338 995,363 C1039,368 1108,412 1168,453 C1228,494 1268,568 1288,638 C1304,688 1290,748 1268,798 C1308,798 1368,824 1428,848"
          fill="none" stroke="#C42820" strokeWidth="3" strokeLinecap="round" opacity=".5" />

        {/* support columns */}
        <g stroke="#2A3042" strokeWidth="5" strokeLinecap="round" opacity=".8">
          <line x1="120" y1="650" x2="120" y2="900" />
          <line x1="300" y1="490" x2="300" y2="900" />
          <line x1="450" y1="468" x2="450" y2="900" />
          <line x1="600" y1="600" x2="600" y2="900" />
          <line x1="728" y1="430" x2="728" y2="900" />
          <line x1="800" y1="148" x2="800" y2="900" />
          <line x1="970" y1="408" x2="970" y2="900" />
          <line x1="1180" y1="465" x2="1180" y2="900" />
          <line x1="1300" y1="650" x2="1300" y2="900" />
        </g>
        {/* cross braces */}
        <g stroke="#2A3042" strokeWidth="3" opacity=".5">
          <line x1="120" y1="900" x2="300" y2="490" />
          <line x1="300" y1="900" x2="120" y2="650" />
          <line x1="300" y1="900" x2="450" y2="468" />
          <line x1="450" y1="900" x2="300" y2="490" />
          <line x1="800" y1="900" x2="970" y2="408" />
          <line x1="970" y1="900" x2="800" y2="148" />
        </g>

        {/* floating accent bursts */}
        <g opacity=".22">
          <polygon points="100,180 106,200 128,200 110,214 116,236 100,222 84,236 90,214 72,200 94,200" fill="#E8362E" />
          <polygon points="1340,140 1344,154 1360,154 1347,163 1351,177 1340,168 1329,177 1333,163 1320,154 1336,154" fill="#FFC629" />
          <polygon points="60,400 64,416 82,416 68,426 72,442 60,432 48,442 52,426 38,416 56,416" fill="#2FA8FF" />
          <polygon points="1380,520 1383,532 1397,532 1386,540 1389,553 1380,545 1371,553 1374,540 1363,532 1377,532" fill="#FFC629" />
        </g>

        {/* coaster car — animated along track */}
        <g filter="url(#ct-carGlow)">
          <rect x="-22" y="-10" width="44" height="18" rx="5" fill="#2FA8FF" stroke="#0e1016" strokeWidth="2" />
          <circle cx="-12" cy="10" r="5" fill="#FFC629" stroke="#0e1016" strokeWidth="1.5" />
          <circle cx="12" cy="10" r="5" fill="#FFC629" stroke="#0e1016" strokeWidth="1.5" />
          <rect x="-10" y="-8" width="20" height="10" rx="3" fill="#1a86cc" stroke="#0e1016" strokeWidth="1" />
          <animateMotion dur="14s" repeatCount="indefinite" rotate="auto" calcMode="spline" keySplines="0.42 0 0.58 1">
            <mpath href="#ct-trackPath" />
          </animateMotion>
        </g>

        {/* speed streaks near car */}
        <g stroke="#FFC629" strokeWidth="2" strokeLinecap="round" opacity=".3">
          <line x1="650" y1="520" x2="680" y2="518" /><line x1="648" y1="528" x2="674" y2="529" />
          <line x1="652" y1="512" x2="670" y2="509" />
        </g>
      </svg>

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

      <div style={{ position: "relative", zIndex: 1, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ width: "100%", maxWidth: 380, background: "rgba(20,23,31,.92)", border: "1px solid rgba(255,255,255,.12)", borderRadius: 20, padding: "36px 32px 32px", backdropFilter: "blur(18px)", boxShadow: "0 0 0 1px rgba(232,54,46,.2), 0 24px 64px rgba(0,0,0,.6)" }}>

          {/* logo lockup */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
            <svg width="46" height="46" viewBox="0 0 100 100">
              <defs><linearGradient id="ct-cg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#F6534B" /><stop offset="1" stopColor="#D92B23" /></linearGradient></defs>
              <rect width="100" height="100" rx="24" fill="url(#ct-cg)" />
              <rect x="1" y="1" width="98" height="98" rx="23" fill="none" stroke="rgba(255,255,255,.22)" strokeWidth="1.5" />
              <path d="M18 71 C 18 22, 46 18, 50 49 C 54 80, 82 74, 82 26" fill="none" stroke="#FFC629" strokeWidth="9" strokeLinecap="round" />
              <circle cx="50" cy="49" r="9" fill="#0e1016" stroke="#FFC629" strokeWidth="4" />
            </svg>
            <div>
              <div style={{ fontFamily: "'Bangers', cursive", fontSize: 26, letterSpacing: 1.5, color: "#fff", lineHeight: 1 }}>
                COASTER <span style={{ color: "#FFC629" }}>ATTACK</span>
              </div>
              <div style={{ font: "500 11px/1.3 Inter, sans-serif", color: "#6d7385", letterSpacing: ".5px", marginTop: 2 }}>Credit Tracker</div>
            </div>
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
