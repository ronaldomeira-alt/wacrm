"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, Flame, Loader2, Sparkles, UserPlus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useLocale, useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { parseNotificationTarget } from "@/lib/match/notification-parser";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Notification } from "@/types";

const TYPE_ICON: Record<Notification["type"], typeof Bell> = {
  conversation_assigned: UserPlus,
  match_created: Sparkles,
  match_reopened: Sparkles,
  match_interest: Flame,
};

export function AssignedNotificationsPopover({
  onlyMatch = false,
}: {
  onlyMatch?: boolean;
}) {
  const t = useTranslations("Notifications.page");
  const appLocale = useLocale();
  const dateFnsLocale = getDateFnsLocale(appLocale);
  const router = useRouter();
  const { accountId } = useAuth();
  const instanceId = useId();
  const [open, setOpen] = useState(false);
  const [filterMode, setFilterMode] = useState<"all" | "unread">("all");
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const { data } = await supabase
      .from("notifications")
      .select("*")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(40);
    setNotifications((data ?? []) as Notification[]);
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`notifications-bell-${onlyMatch ? "match" : "all"}-${instanceId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const row = payload.new as Notification;
            setNotifications((prev) => {
              if (!prev) return [row];
              if (prev.some((n) => n.id === row.id)) return prev;
              return [row, ...prev];
            });
          } else if (payload.eventType === "UPDATE") {
            const row = payload.new as Notification;
            setNotifications(
              (prev) => prev?.map((n) => (n.id === row.id ? { ...n, ...row } : n)) ?? prev
            );
          } else if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Notification>;
            setNotifications((prev) => prev?.filter((n) => n.id !== oldRow.id) ?? prev);
          }
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [onlyMatch, instanceId]);

  const markRead = useCallback(
    async (id: string) => {
      setNotifications(
        (prev) =>
          prev?.map((n) =>
            n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n
          ) ?? prev
      );
      const supabase = createClient();
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id)
        .is("read_at", null);
      if (error) {
        toast.error(t("toastMarkReadError"));
        load();
      }
    },
    [load, t]
  );

  const handleClick = useCallback(
    (n: Notification) => {
      if (!n.read_at) markRead(n.id);
      setOpen(false);
      const parsed = parseNotificationTarget(n);
      router.push(parsed.targetUrl);
    },
    [markRead, router, setOpen]
  );

  const scopedNotifications = (notifications ?? []).filter((n) => {
    if (!onlyMatch) return true;
    return parseNotificationTarget(n).isMatchNotification;
  });

  const visibleNotifications =
    filterMode === "unread"
      ? scopedNotifications.filter((n) => !n.read_at)
      : scopedNotifications;

  const unreadIds = scopedNotifications.filter((n) => !n.read_at).map((n) => n.id);

  const markAllRead = useCallback(async () => {
    if (unreadIds.length === 0) return;
    setMarkingAll(true);
    const now = new Date().toISOString();
    const idSet = new Set(unreadIds);
    setNotifications(
      (prev) => prev?.map((n) => (idSet.has(n.id) ? { ...n, read_at: now } : n)) ?? prev
    );
    const supabase = createClient();
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: now })
      .in("id", unreadIds)
      .is("read_at", null);
    setMarkingAll(false);
    if (error) {
      toast.error(t("toastMarkAllError"));
      load();
    }
  }, [unreadIds, load, t]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="icon-sm"
            className="relative"
            aria-label={onlyMatch ? "Notificações de Match" : t("title")}
            title={onlyMatch ? "Notificações de Match" : t("title")}
          />
        }
      >
        <Bell className="h-4 w-4" />
        {unreadIds.length > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground">
            {unreadIds.length > 9 ? "9+" : unreadIds.length}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-foreground">
              {onlyMatch ? "Alertas de Match" : t("title")}
            </p>
            {unreadIds.length > 0 && (
              <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                {unreadIds.length} não {unreadIds.length === 1 ? "lida" : "lidas"}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={unreadIds.length === 0 || markingAll}
            onClick={markAllRead}
            className="h-7 text-xs gap-1"
          >
            {markingAll ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCheck className="h-3.5 w-3.5" />
            )}
            {t("markAllRead")}
          </Button>
        </div>

        {/* Filtro Rápido: Todas vs Não Lidas */}
        <div className="flex items-center gap-1 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs">
          <button
            type="button"
            onClick={() => setFilterMode("all")}
            className={cn(
              "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
              filterMode === "all"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Todas ({scopedNotifications.length})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("unread")}
            className={cn(
              "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
              filterMode === "unread"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Não lidas ({unreadIds.length})
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto p-2">
          {notifications === null ? (
            <div className="flex h-20 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            </div>
          ) : visibleNotifications.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {filterMode === "unread"
                ? "Nenhuma notificação não lida no momento."
                : t("emptyTitle")}
            </p>
          ) : (
            <ul className="space-y-1">
              {visibleNotifications.map((n) => {
                const parsed = parseNotificationTarget(n);
                const Icon = parsed.isMatchNotification
                  ? Sparkles
                  : TYPE_ICON[n.type] ?? Bell;
                const isUnread = !n.read_at;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => handleClick(n)}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-lg p-2.5 text-left transition-colors border",
                        isUnread
                          ? "bg-primary/5 border-primary/25 hover:bg-primary/10"
                          : "border-transparent hover:bg-muted"
                      )}
                    >
                      <div
                        className={cn(
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg mt-0.5",
                          isUnread ? "bg-primary/15" : "bg-muted"
                        )}
                      >
                        <Icon
                          className={cn(
                            "h-3.5 w-3.5",
                            isUnread ? "text-primary" : "text-muted-foreground"
                          )}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p
                            className={cn(
                              "truncate text-xs font-semibold",
                              isUnread ? "text-foreground" : "text-muted-foreground"
                            )}
                          >
                            {n.title}
                          </p>
                          {isUnread && (
                            <span
                              className="size-2 shrink-0 rounded-full bg-primary"
                              title="Não lida"
                            />
                          )}
                        </div>
                        {parsed.cleanBody && (
                          <p
                            className={cn(
                              "mt-0.5 text-[11px] line-clamp-2",
                              isUnread ? "text-foreground/90" : "text-muted-foreground"
                            )}
                          >
                            {parsed.cleanBody}
                          </p>
                        )}
                        <p className="mt-1 text-[10px] text-muted-foreground/70">
                          {formatDistanceToNow(new Date(n.created_at), {
                            addSuffix: true,
                            locale: dateFnsLocale,
                          })}
                        </p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
