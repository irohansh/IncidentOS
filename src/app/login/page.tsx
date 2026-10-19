'use client';

import { useState, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const form = new FormData(e.currentTarget);
    const username = form.get('username') as string;
    const password = form.get('password') as string;

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? 'Login failed');
        return;
      }

      const next = searchParams.get('next') ?? '/';
      router.push(next);
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '10vh auto', fontFamily: 'monospace', padding: '0 1rem' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '1.5rem' }}>IncidentOS</h1>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: 4 }}>Username</label>
          <input
            name="username"
            type="text"
            required
            autoFocus
            style={{ width: '100%', padding: '8px', boxSizing: 'border-box', fontFamily: 'monospace' }}
          />
        </div>
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: 4 }}>Password</label>
          <input
            name="password"
            type="password"
            required
            style={{ width: '100%', padding: '8px', boxSizing: 'border-box', fontFamily: 'monospace' }}
          />
        </div>
        {error && (
          <p style={{ color: '#c00', marginBottom: '1rem', fontSize: '0.9rem' }}>{error}</p>
        )}
        <button
          type="submit"
          disabled={loading}
          style={{ padding: '8px 20px', cursor: loading ? 'wait' : 'pointer', fontFamily: 'monospace' }}
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
