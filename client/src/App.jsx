import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { Alert, AlertDescription, AlertTitle, Card, Spinner } from '@mieweb/ui';

function Brand() {
  return (
    <div className="mb-6 flex items-center justify-center gap-2 text-sm font-bold uppercase tracking-wide text-ozwell">
      <img src="/favicon.png" alt="" className="h-7 w-7" />
      Ozwell Studio
    </div>
  );
}

function Waiting() {
  return (
    <>
      <Spinner size="xl" label="Loading" className="mx-auto mb-6" />
      <h1 className="mb-2 text-xl font-bold text-foreground">Setting up your workspace</h1>
      <p className="text-muted-foreground" aria-live="polite">
        This usually takes a minute or two. Please keep this tab open&hellip;
      </p>
    </>
  );
}

function Failed({ message }) {
  return (
    <Alert variant="danger" className="text-left">
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>{message || 'Please try again later.'}</AlertDescription>
    </Alert>
  );
}

function NotFound() {
  return (
    <Alert variant="warning" className="text-left">
      <AlertTitle>Not found</AlertTitle>
      <AlertDescription>This page does not exist.</AlertDescription>
    </Alert>
  );
}

export default function App() {
  const notFound = window.location.pathname !== '/';
  const [status, setStatus] = useState({ state: 'creating' });

  useEffect(() => {
    if (notFound) return undefined;
    const socket = io();
    socket.on('status', (next) => {
      if (next.state === 'ready') {
        window.location.replace(next.url);
        return;
      }
      setStatus(next);
    });
    return () => socket.close();
  }, [notFound]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-[min(26rem,calc(100vw-2rem))] p-8 text-center">
        <Brand />
        {notFound ? <NotFound /> : status.state === 'error' ? <Failed message={status.message} /> : <Waiting />}
      </Card>
    </main>
  );
}
