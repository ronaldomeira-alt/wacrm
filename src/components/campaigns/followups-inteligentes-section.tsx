
'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Loader2, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';

import { toast } from 'sonner';

// Definição de tipo para os planos de follow-up (pode ser movido para um arquivo de tipos)
type FollowupPlan = {
  id: string;
  status: 'active' | 'completed' | 'cancelled';
  created_at: string;
  contact: {
    id: string;
    name: string;
    phone: string;
  };
  scheduled_sends: {
    id: string;
    send_at: string;
    status: 'pending' | 'sent' | 'cancelled';
    template_name: string;
  }[];
};

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
    setLoading(true);
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

    if (error) {
      console.error('Error fetching followup plans:', error);
      // toast.error(t('fetchError'));
    } else {
      setPlans(data as FollowupPlan[]);
    }
    setLoading(false);
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

  if (loading) {
    return (
      <div className="flex justify-center items-center py-10">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <Card className="text-center py-10">
        <CardContent>
          <p className="text-muted-foreground">{t('noPlansFound')}</p>
        </CardContent>
      </Card>
    );
  }

  const getStatusVariant = (status: FollowupPlan['status']) => {
    switch (status) {
      case 'active': return 'default';
      case 'completed': return 'success';
      case 'cancelled': return 'destructive';
      default: return 'secondary';
    }
  };

  return (
    <div className="space-y-4">
      {plans.map(plan => (
        <Card key={plan.id}>
          <CardHeader>
            <CardTitle className="flex justify-between items-center">
              <span>{plan.contact.name}</span>
              <Badge variant={getStatusVariant(plan.status)}>{t(`status.${plan.status}`)}</Badge>
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
      ))}
    </div>
  );
}

