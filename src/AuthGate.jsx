import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import { setHouseholdId } from "../credit-tracker.jsx";

const wrap = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f172a" };
const card = { width: 340, background: "#1e293b", borderRadius: 12, padding: 28, color: "#e2e8f0", fontFamily: "system-ui, sans-serif" };
const input = { width: "100%", boxSizing: "border-box", padding: "9px 11px", marginBottom: 10, borderRadius: 6, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0", fontSize: 14 };
const button = { width: "100%", padding: "10px 0", borderRadius: 6, border: "none", background: "#38bdf8", color: "#0f172a", fontWeight: 600, fontSize: 14, cursor: "pointer" };
const linkBtn = { background: "none", border: "none", color: "#38bdf8", cursor: "pointer", fontSize: 13, marginTop: 12, width: "100%", textAlign: "center" };

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
    <div style={wrap}>
      <div style={card}>
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>🎢 Coaster Tracker</h2>
        <form onSubmit={submit}>
          <input style={input} type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
          <input style={input} type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
          {error && <div style={{ color: "#f87171", fontSize: 13, marginBottom: 10 }}>{error}</div>}
          {notice && <div style={{ color: "#4ade80", fontSize: 13, marginBottom: 10 }}>{notice}</div>}
          <button style={button} type="submit" disabled={busy}>
            {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create household"}
          </button>
        </form>
        <button style={linkBtn} onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
          {mode === "signin" ? "New here? Create a household account" : "Already have an account? Sign in"}
        </button>
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
