'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bell, BellOff, Loader2, RefreshCw, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';

// Custom feature (not part of the upstream wacrm template): lets a
// user turn this device (e.g. an iPhone with the app added to the
// Home Screen) into a push-notification target for new inbound
// WhatsApp messages. See src/lib/push/send.ts for the server side and
// public/sw.js for the service worker that renders the notification.

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

type Status = 'checking' | 'unsupported' | 'denied' | 'enabled' | 'disabled';

export function PushNotificationsCard() {
  const t = useTranslations('PushNotifications');
  const [status, setStatus] = useState<Status>('checking');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (
        typeof window === 'undefined' ||
        !('serviceWorker' in navigator) ||
        !('PushManager' in window)
      ) {
        setStatus('unsupported');
        return;
      }
      if (Notification.permission === 'denied') {
        setStatus('denied');
        return;
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        const sub = await reg?.pushManager.getSubscription();
        if (!cancelled) setStatus(sub ? 'enabled' : 'disabled');
      } catch {
        if (!cancelled) setStatus('disabled');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Shared by "Ativar" and "Renovar inscrição". `force` tears down
  // whatever subscription the browser already thinks is active first —
  // needed because iOS Safari has a well-documented failure mode where
  // a Home Screen PWA's push subscription silently stops being
  // delivered (survives device restarts, iOS updates, or just goes
  // stale over time) while the browser API still happily reports it as
  // subscribed. There's no way to detect that from here except letting
  // the person notice test notifications aren't arriving and forcing a
  // clean resubscribe — reusing the stale subscription (the old
  // `enable` behavior) would silently do nothing.
  const subscribeDevice = async (force: boolean) => {
    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!publicKey) {
      toast.error(t('genericError'));
      return false;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setStatus('denied');
      return false;
    }

    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (sub && force) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
    }

    const json = sub.toJSON();
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
      }),
    });
    if (!res.ok) throw new Error('subscribe failed');
    return true;
  };

  const enable = async () => {
    setBusy(true);
    try {
      const ok = await subscribeDevice(false);
      if (ok) {
        setStatus('enabled');
        toast.success(t('enabledToast'));
      }
    } catch {
      toast.error(t('genericError'));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const ok = await subscribeDevice(true);
      if (ok) {
        setStatus('enabled');
        toast.success(t('refreshedToast'));
      }
    } catch {
      toast.error(t('genericError'));
    } finally {
      setRefreshing(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setStatus('disabled');
      toast.success(t('disabledToast'));
    } catch {
      toast.error(t('genericError'));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/push/test', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || t('testError'));
        return;
      }
      toast.success(t('testSuccess'));
    } catch {
      toast.error(t('testError'));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Bell className="size-4 text-primary" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        {status === 'checking' && (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}

        {status === 'unsupported' && (
          <p className="text-sm text-muted-foreground">{t('notSupported')}</p>
        )}

        {status === 'denied' && (
          <p className="text-sm text-muted-foreground">{t('permissionDenied')}</p>
        )}

        {status === 'disabled' && (
          <Button type="button" onClick={enable} disabled={busy}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Bell className="size-4" />
            )}
            {t('enableBtn')}
          </Button>
        )}

        {status === 'enabled' && (
          <>
            <div className="flex w-full flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary-on-soft">
                <Bell className="size-3" />
                {t('enabledBadge')}
              </span>
              <Button
                type="button"
                variant="outline"
                onClick={sendTest}
                disabled={testing}
              >
                {testing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                {t('testBtn')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={refresh}
                disabled={refreshing}
              >
                {refreshing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {t('refreshBtn')}
              </Button>
              <Button type="button" variant="ghost" onClick={disable} disabled={busy}>
                <BellOff className="size-4" />
                {t('disableBtn')}
              </Button>
            </div>
            <p className="w-full text-xs text-muted-foreground">{t('notArrivingHint')}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
