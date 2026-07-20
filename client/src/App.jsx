import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  Skeleton,
  Spinner,
} from '@mieweb/ui';

const STATUS_BADGES = {
  running: 'success',
  creating: 'default',
  offline: 'warning',
  failed: 'danger',
  missing: 'warning',
  unknown: 'secondary',
};

function Brand() {
  return (
    <div className="mb-6 flex items-center justify-center gap-2 text-sm font-bold uppercase tracking-wide text-ozwell">
      <img src="/favicon.png" alt="" className="h-7 w-7" />
      Ozwell Studio
    </div>
  );
}

function StudioRow({ studio, opening, onOpen }) {
  const clickable = studio.status === 'running' || studio.status === 'offline';
  const isOpening = opening === studio.hostname;
  return (
    <li>
      <button
        type="button"
        onClick={() => clickable && onOpen(studio)}
        disabled={!clickable}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left hover:enabled:border-primary-300 hover:enabled:bg-primary-50 disabled:cursor-default dark:hover:enabled:bg-primary-950"
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-foreground">{studio.hostname}</span>
          {studio.createdAt && (
            <span className="text-xs text-muted-foreground">
              created {new Date(studio.createdAt).toLocaleString()}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {(studio.status === 'creating' || isOpening) && <Spinner size="sm" />}
          <Badge variant={STATUS_BADGES[studio.status] ?? 'secondary'}>
            {studio.status}
          </Badge>
        </span>
      </button>
    </li>
  );
}

export default function App() {
  const [studios, setStudios] = useState(null);
  const [error, setError] = useState(null);
  const [opening, setOpening] = useState(null);
  const openWhenReady = useRef(null);

  useEffect(() => {
    fetch('/api/v1/studios')
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
        return res.json();
      })
      .then(({ studios: list }) => setStudios(list))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    const socket = io();
    // Server-pushed provisioning updates; `status` is the same vocabulary
    // the REST API uses (creating/running/failed + manager statuses).
    socket.on('status', (event) => {
      if (!event.hostname) {
        // Connection-level rejection (auth) — surface it.
        setError(event.message);
        return;
      }
      setStudios((list) =>
        (list ?? []).map((c) =>
          c.hostname === event.hostname ? { ...c, status: event.status, url: event.url } : c
        )
      );
      if (event.status === 'running' && openWhenReady.current === event.hostname) {
        window.location.assign(event.url);
      }
      if (event.status === 'failed') {
        setError(event.message);
        setOpening(null);
      }
    });
    return () => socket.close();
  }, []);

  const createStudio = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/v1/studios', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const { studio } = await res.json();
      openWhenReady.current = studio.hostname;
      setOpening(studio.hostname);
      setStudios((list) => [studio, ...(list ?? [])]);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const openStudio = useCallback((studio) => {
    window.location.assign(studio.url);
  }, []);

  return (
    <main className="flex min-h-screen items-start justify-center bg-background py-16">
      <Card className="w-[min(30rem,calc(100vw-2rem))] p-8">
        <Brand />
        <div className="mb-4 flex items-center justify-between gap-4">
          <h1 className="text-xl font-bold text-foreground">Your Studios</h1>
          <Button variant="primary" onClick={createStudio} disabled={opening !== null}>
            {opening ? (
              <span className="flex items-center gap-2">
                <Spinner size="sm" variant="white" /> Creating&hellip;
              </span>
            ) : (
              'New Studio'
            )}
          </Button>
        </div>

        {error && (
          <Alert variant="danger" className="mb-4 text-left">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {studios === null && !error && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        )}

        {studios !== null && studios.length === 0 && (
          <p className="py-6 text-center text-muted-foreground">
            You don&apos;t have any studios yet. Create one to get started.
          </p>
        )}

        {studios !== null && studios.length > 0 && (
          <ul className="flex flex-col gap-2">
            {studios.map((studio) => (
              <StudioRow
                key={studio.hostname}
                studio={studio}
                opening={opening}
                onOpen={openStudio}
              />
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
