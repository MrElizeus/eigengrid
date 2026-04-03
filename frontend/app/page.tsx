'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

export default function LoginPage() {
  useEffect(() => {
    const stored = localStorage.getItem('eigengrid_dark');
    const isDark = stored ? stored === 'true' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (isDark) document.documentElement.classList.add('dark');
  }, []);
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      localStorage.setItem('eigengrid_token', returnedToken);
      setStatus('Redirecting to dashboard…');
      router.push('/dashboard');
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : 'Something failed.');
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-100 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-8">
        <div className="space-y-3 text-center">
          <p className="text-xs uppercase tracking-[0.5rem] text-slate-500 dark:text-slate-400">
            EigenGrid
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">
            Operations Dashboard
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Sign in to access your grid operations.
          </p>
        </div>
        <form
          onSubmit={handleSubmit}
          className="border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm bg-white dark:bg-slate-900 space-y-5"
        >
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 rounded-lg px-4 py-2">
              {error}
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300" htmlFor="email">
              Email address
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2.5 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 dark:focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-600/20 dark:focus:ring-blue-500/20 transition"
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2.5 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 dark:focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-600/20 dark:focus:ring-blue-500/20 transition"
              placeholder="••••••••••"
            />
          </div>
          <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-600 dark:focus:ring-blue-500 bg-white dark:bg-slate-800"
              />
              Remember me
            </label>
            <span className="text-slate-400 dark:text-slate-500">Need an account? Contact admin</span>
          </div>
          <button
            type="submit"
            className="w-full rounded-lg bg-blue-600 dark:bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700 dark:hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            Sign in
          </button>
          {status && (
            <p className="text-sm text-slate-500 dark:text-slate-400">{status}</p>
          )}
        </form>
      </div>
    </div>
  );
}
