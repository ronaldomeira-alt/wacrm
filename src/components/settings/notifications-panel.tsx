'use client';

import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';
import { PushNotificationsCard } from './push-notifications-card';

/**
 * Notifications panel — its own section (moved out of Appearance, where
 * it was easy to miss: nothing about "mobile push" belongs under a
 * light/dark-mode + accent-color settings screen). Currently a single
 * card (push notifications to this device), but its own home means a
 * future notification preference (e.g. per-event toggles) has somewhere
 * coherent to go without another relocation.
 */
export function NotificationsPanel() {
  const t = useTranslations('Settings.notifications');

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <PushNotificationsCard />
    </section>
  );
}
