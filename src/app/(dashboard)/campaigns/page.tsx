'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast } from '@/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Megaphone, Plus, Loader2, Play, Trash2, Send, Bot } from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getBroadcastStatus } from '@/lib/broadcast-status';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { EnviosSection } from '@/components/campaigns/envios-section';
import { FollowupsInteligentesSection } from '@/components/campaigns/followups-inteligentes-section';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

const POLL_INTERVAL_MS = 5_000;

// Componentes RateStat e outros permanecem os mesmos...

export default function CampaignsPage() {
  const router = useRouter();
  const t = useTranslations('Campaigns.page');
  const tTabs = useTranslations('Campaigns.tabs');

  // ... (hooks e estado existentes)

  return (
    <div className="space-y-6">
      {/* ... (barra de progresso e header) */}

      <Tabs defaultValue="campaigns" className="space-y-6">
        <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="campaigns"><Megaphone className="h-4 w-4 mr-2"/>{tTabs('campaigns')}</TabsTrigger>
            <TabsTrigger value="sends"><Send className="h-4 w-4 mr-2"/>{tTabs('sends')}</TabsTrigger>
            <TabsTrigger value="followups"><Bot className="h-4 w-4 mr-2"/>{tTabs('followups')}</TabsTrigger>
        </TabsList>
        <TabsContent value="campaigns">
          {/* Conteúdo original da listagem de campanhas aqui */}
        </TabsContent>
        <TabsContent value="sends">
          <EnviosSection />
        </TabsContent>
        <TabsContent value="followups">
          <FollowupsInteligentesSection />
        </TabsContent>
    </Tabs>

    {/* ... (modais de diálogo) */}
    </div>
  );
}
