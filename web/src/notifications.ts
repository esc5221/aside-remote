import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseChat } from './types';

const PRESENCE_INTERVAL_MS = 10_000;
const NOTIFICATION_TIMEOUT_MS = 10_000;
const ENABLE_ERROR = 'Could not enable notifications. Try again.';

function unavailableReason() {
  if (!window.isSecureContext) return 'Open Aside over HTTPS to enable notifications.';
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isInstalled = matchMedia('(display-mode: standalone)').matches || ('standalone' in navigator && navigator.standalone === true);
  if (isIOS && !isInstalled) return 'Add Aside to your Home Screen, then open it to enable notifications.';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'Notifications are not supported in this browser.';
}

function applicationServerKey(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(value)) throw new Error(ENABLE_ERROR);
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), character => character.charCodeAt(0)).buffer;
}

async function registerWorker() {
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  if (registration.active) return registration;
  let timeout: number | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error(ENABLE_ERROR)), NOTIFICATION_TIMEOUT_MS); }),
    ]);
  } finally { window.clearTimeout(timeout); }
}

export function usePushNotifications(chat: UseChat, notify: (text: string, kind?: 'error' | 'success') => void) {
  const [reason] = useState(unavailableReason);
  const [status, setStatus] = useState<'checking' | 'enabled' | 'disabled' | 'denied' | 'unavailable'>(reason ? 'unavailable' : 'checking');
  const [isUpdating, setUpdating] = useState(false);
  const [subscriptionId, setSubscriptionId] = useState<string>();
  const [clientId] = useState(() => crypto.randomUUID());
  const subscriptionRef = useRef<PushSubscription | undefined>(undefined);
  const registrationRef = useRef<ServiceWorkerRegistration | undefined>(undefined);
  const keyRef = useRef<ArrayBuffer | undefined>(undefined);
  const isActingRef = useRef(false);
  const presenceRevisionRef = useRef(0);
  const request = chat.request;
  const hasAccess = chat.isReady && !chat.authError;

  const prepare = useCallback(async () => {
    const [registration, response] = await Promise.all([
      registerWorker(),
      request('/api/push/config', { cache: 'no-store', signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS) }),
    ]);
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null || !('publicKey' in payload)) throw new Error(ENABLE_ERROR);
    const key = applicationServerKey(payload.publicKey);
    registrationRef.current = registration;
    keyRef.current = key;
    return registration;
  }, [request]);

  const saveSubscription = useCallback(async (subscription: PushSubscription) => {
    const response = await request('/api/push/subscriptions', {
      method: 'PUT', body: JSON.stringify({ subscription: subscription.toJSON(), origin: location.origin }),
      signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
    });
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null || !('id' in payload) || typeof payload.id !== 'string' || !/^[a-f0-9]{64}$/.test(payload.id)) throw new Error(ENABLE_ERROR);
    return payload.id;
  }, [request]);

  useEffect(() => {
    if (reason || !hasAccess || isActingRef.current) return;
    let isCancelled = false;
    async function restore() {
      if (isActingRef.current) return;
      try {
        const registration = await prepare();
        if (isCancelled) return;
        const subscription = await registration.pushManager.getSubscription();
        if (isCancelled || isActingRef.current) return;
        if (Notification.permission === 'granted' && subscription) {
          const id = await saveSubscription(subscription);
          if (!isCancelled && !isActingRef.current) {
            subscriptionRef.current = subscription;
            setSubscriptionId(id);
            setStatus('enabled');
          }
        } else {
          subscriptionRef.current = undefined;
          setSubscriptionId(undefined);
          setStatus(Notification.permission === 'denied' ? 'denied' : 'disabled');
        }
      } catch {
        if (!isCancelled) setStatus(Notification.permission === 'denied' ? 'denied' : 'disabled');
      }
    }
    void restore();
    const onVisible = () => { if (document.visibilityState === 'visible') void restore(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => { isCancelled = true; window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, [reason, hasAccess, chat.isConnected, prepare, saveSubscription]);

  useEffect(() => {
    if (!subscriptionId || !hasAccess) return;
    function presence(isFocused: boolean) {
      void request('/api/push/presence', {
        method: 'POST', keepalive: !isFocused,
        body: JSON.stringify({ subscriptionId, clientId, revision: ++presenceRevisionRef.current, isFocused }),
        signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
      }).catch(() => undefined);
    }
    const update = () => presence(document.visibilityState === 'visible' && document.hasFocus());
    const hide = () => presence(false);
    update();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && document.hasFocus()) presence(true); }, PRESENCE_INTERVAL_MS);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', hide);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', update);
    window.addEventListener('online', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', hide);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', update);
      window.removeEventListener('online', update);
      hide();
    };
  }, [clientId, subscriptionId, hasAccess, chat.isConnected, request]);

  async function enable() {
    if (reason || !hasAccess || isActingRef.current) return;
    isActingRef.current = true; setUpdating(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'disabled');
        return;
      }
      const registration = registrationRef.current ?? await prepare();
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyRef.current });
      const id = await saveSubscription(subscription);
      subscriptionRef.current = subscription;
      setSubscriptionId(id);
      setStatus('enabled');
      notify('Notifications enabled.', 'success');
    } catch { notify(ENABLE_ERROR, 'error'); }
    finally { isActingRef.current = false; setUpdating(false); }
  }

  async function disable() {
    if (!subscriptionId || isActingRef.current) return;
    isActingRef.current = true; setUpdating(true);
    try {
      await subscriptionRef.current?.unsubscribe();
      if (await registrationRef.current?.pushManager.getSubscription()) throw new Error('Notifications are still enabled.');
      await request(`/api/push/subscriptions/${subscriptionId}`, { method: 'DELETE', signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS) }).catch(() => undefined);
      subscriptionRef.current = undefined;
      setSubscriptionId(undefined);
      setStatus('disabled');
      notify('Notifications turned off.', 'success');
    } catch { notify('Could not turn off notifications. Try again.', 'error'); }
    finally { isActingRef.current = false; setUpdating(false); }
  }

  return { status, unavailableReason: reason, isUpdating, enable, disable };
}

export type PushNotifications = ReturnType<typeof usePushNotifications>;
