'use client';

import { FormEvent, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus('logging in …');
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, remember }),
      });

      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.message ?? 'Invalid credentials.');
      }

      const body = await response.json();
      const returnedToken = body.token as string | undefined;

      if (!returnedToken) {
        throw new Error('No token was returned from the API.');
      }

      setToken(returnedToken);
      localStorage.setItem('eigengrid_token', returnedToken);
      setStatus('Logged in successfully');
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : 'Something failed.');
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-8">
        <div className="space-y-3 text-center">
          <p className="text-xs uppercase tracking-[0.5rem] text-emerald-400">
            EigenGrid
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Access your operations dashboard
          </h1>
          <p className="text-sm text-slate-400">
            Sign in with the Laravel API below. This screen only powers the
            JavaScript experience.
          </p>
        </div>
        <form
          onSubmit={handleSubmit}
          className="bg-slate-900/70 border border-slate-800/70 rounded-2xl p-6 shadow-[0_20px_45px_rgba(2,6,23,0.9)] space-y-5 backdrop-blur"
        >
          {error && (
            <div className="text-sm text-rose-300 border border-rose-800/70 bg-rose-900/20 rounded-xl px-4 py-2">
              {error}
            </div>
          )}
          <div className="space-y-2">
            <label className="text-sm text-slate-400" htmlFor="email">
              Email address
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-50 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition"
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-slate-400" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-base text-slate-50 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition"
              placeholder="••••••••••"
            />
          </div>
          <div className="flex items-center justify-between text-sm text-slate-400">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-400"
              />
              Remember me
            </label>
            <span className="text-emerald-300">Need an account? Contact admin</span>
          </div>
          <button
            type="submit"
            className="w-full rounded-2xl bg-gradient-to-r from-emerald-400/90 to-slate-800/90 px-4 py-3 text-base font-semibold text-slate-950 transition hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
          >
            Sign in
          </button>
          {status && (
            <p className="text-sm text-emerald-300">{status}</p>
          )}
        </form>

        <div className="text-xs text-slate-500 tracking-wide uppercase border border-dashed border-slate-800/50 rounded-2xl px-4 py-3">
          The API server issues a Sanctum token (not a rendered view). Keep the
          token safe—use it as a `Bearer` header in follow-up requests.
        </div>
        {token && (
          <div className="text-xs text-emerald-300 pt-2">
            Token stored in localStorage. Preview: {token.slice(0, 8)}...
          </div>
        )}
      </div>
    </div>
  );
}
