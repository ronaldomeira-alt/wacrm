'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Loader2, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';

import { toast } from 'sonner';

// Follow-up Inteligente — lists approved 2-contact plans queued into
// scheduled_sends and dispatched by the existing follow-up cron
// (processDueFollowupSends). Row shape here mirrors the embedded
// select below, not a generated Database type (this project doesn't
// generate one for the untyped supabase-js client).
type FollowupPlan = {
  id: string;
  status: 'active' | 'completed' | 'cancelled';
  created_at: string;
  contact: {
    id: string;
    name: string;
    phone: string;
  } | null;
  scheduled_sends: {
    id: string;
    send_at: string;
    status: 'pending' | 'sent' | 'cancelled' | 'failed';
    template_name: string;
  }[];
};

function statusBadgeProps(status: FollowupPlan['status']): { variant: 'default' | 'outline' | 'destructive'; className?: string } {
  switch (status) {
    case 'completed':
      return { variant: 'outline', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' };
    case 'cancelled':
      return { variant: 'destructive' };
    default:
      return { variant: 'default' };
  }
}

export function FollowupsInteligentesSection() {
  const t = useTranslations('Campaigns.followups');
  const [plans, setPlans] = useState<FollowupPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});
  const supabase = createClient();

  async function handleCancelPlan(planId: string) {
    setCancelling(prev => ({ ...prev, [planId]: true }));
    const response = await fetch(`/api/followup-plans/${planId}/cancel`, {
      method: 'POST',
    });

    if (response.ok) {
      toast.success(t('cancelSuccess'));
      // A UI irá atualizar automaticamente via subscription
    } else {
      const data = await response.json();
      toast.error(data.error || t('cancelError'));
    }
    setCancelling(prev => ({ ...prev, [planId]: false }));
  }

  async function fetchFollowupPlans() {
    try {
      const { data, error } = await supabase
        .from('followup_plans')
        .select(`
          id,
          status,
          created_at,
          contact:contacts(id, name, phone),
          scheduled_sends(id, send_at, status, template_name)
        `)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setPlans((data ?? []) as unknown as FollowupPlan[]);
    } catch (err) {
      console.error('Error fetching followup plans:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchFollowupPlans();
    // Adicionar subscription para atualizações em tempo real
    const channel = supabase
      .channel('followup_plans_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'followup_plans' },
        () => fetchFollowupPlans()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'scheduled_sends' },
        () => fetchFollowupPlans()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {loading ? (
        <div className="flex justify-center items-center py-10">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : plans.length === 0 ? (
        <Card className="text-center py-10">
          <CardContent>
            <p className="text-muted-foreground">{t('noPlansFound')}</p>
          </CardContent>
        </Card>
      ) : (
        plans.map(plan => {
          const badge = statusBadgeProps(plan.status);
          return (
        <Card key={plan.id}>
          <CardHeader>
            <CardTitle className="flex justify-between items-center">
              <span>{plan.contact?.name ?? '—'}</span>
              <Badge variant={badge.variant} className={badge.className}>{t(`status.${plan.status}`)}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <h4 className="font-semibold">{t('sendsTitle')}</h4>
              <ul className="list-disc list-inside space-y-1">
                {plan.scheduled_sends.map(send => (
                  <li key={send.id} className="text-sm">
                    {send.template_name} - {new Date(send.send_at).toLocaleString()}
                    <Badge variant="outline" className="ml-2">{t(`sendStatus.${send.status}`)}</Badge>
                  </li>
                ))}
              </ul>
            </div>
            {plan.status === 'active' && (
               <div className="mt-4 flex justify-end">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleCancelPlan(plan.id)}
                  disabled={cancelling[plan.id]}
                >
                  {cancelling[plan.id] ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4 mr-2" />
                  )}
                  {t('cancelPlan')}
                </Button>
               </div>
            )}
          </CardContent>
        </Card>
          );
        })
      )}
    </div>
  );
}

