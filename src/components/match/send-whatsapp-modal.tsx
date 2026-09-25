'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { MessageSquare, Send, Building2, ExternalLink, Loader2, Sparkles } from 'lucide-react';

interface SendWhatsAppModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  matchId?: string;
  leadId: string;
  leadName: string;
  leadPhone: string;
  propertyId: string;
  propertyTitle: string;
  propertyNeighborhood: string;
  propertyPriceMin?: number;
  propertyCoverUrl?: string | null;
  matchScore: number;
  onSent: () => void;
}

export function SendWhatsAppModal({
  open,
  onOpenChange,
  matchId,
  leadId,
  leadName,
  leadPhone,
  propertyId,
  propertyTitle,
  propertyNeighborhood,
  propertyPriceMin,
  propertyCoverUrl,
  matchScore,
  onSent,
}: SendWhatsAppModalProps) {
  const [messageText, setMessageText] = useState(
    'Encontrei uma opção que combina com o que você está procurando. Dá uma olhada e me diz o que achou:'
  );
  const [sending, setSending] = useState(false);

  async function handleSend() {
    if (!leadPhone) {
      toast.error('Este lead não possui telefone cadastrado');
      return;
    }

    setSending(true);
    try {
      const res = await fetch('/api/match/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: leadId,
          property_id: propertyId,
          match_id: matchId || null,
          message_text: messageText,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Falha ao registrar envio');
      }

      // Abre imediatamente o WhatsApp pessoal com o texto e o link individualizado
      if (data.waLink) {
        window.open(data.waLink, '_blank', 'noopener,noreferrer');
      }

      toast.success('Imóvel marcado como enviado! WhatsApp aberto para envio.');
      onSent();
      onOpenChange(false);
    } catch (err) {
      console.error(err);
      toast.error((err as Error).message || 'Erro ao preparar envio');
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="size-5 text-emerald-500" />
            Enviar Imóvel via WhatsApp Pessoal
          </DialogTitle>
          <DialogDescription className="text-xs">
            O envio será realizado através do seu WhatsApp pessoal. Ao confirmar, o imóvel será marcado
            como <strong>Enviado</strong> no CRM com link de rastreamento exclusivo.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Card Resumo do Imóvel */}
          <div className="flex gap-3 rounded-xl border border-border bg-muted/40 p-3">
            {propertyCoverUrl ? (
              <img
                src={propertyCoverUrl}
                alt={propertyTitle}
                className="size-16 rounded-lg object-cover border border-border"
              />
            ) : (
              <div className="flex size-16 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
                <Building2 className="size-6" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h4 className="truncate text-sm font-semibold text-foreground">{propertyTitle}</h4>
                <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/10 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-400">
                  <Sparkles className="size-2.5" />
                  {matchScore}%
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{propertyNeighborhood}</p>
              {propertyPriceMin && propertyPriceMin > 0 && (
                <p className="mt-1 text-xs font-medium text-foreground">
                  A partir de R$ {propertyPriceMin.toLocaleString('pt-BR')}
                </p>
              )}
            </div>
          </div>

          {/* Destinatário */}
          <div className="flex items-center justify-between rounded-lg bg-card border border-border px-3 py-2 text-xs">
            <span className="text-muted-foreground">Destinatário:</span>
            <span className="font-medium text-foreground">
              {leadName} <span className="text-muted-foreground">({leadPhone})</span>
            </span>
          </div>

          {/* Texto Editável */}
          <div className="space-y-1.5">
            <Label htmlFor="messageText" className="text-xs font-medium text-foreground">
              Mensagem de introdução (editável)
            </Label>
            <Textarea
              id="messageText"
              rows={3}
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              className="resize-none text-xs"
              placeholder="Digite a mensagem que antecede o link..."
            />
          </div>

          {/* Preview do Link com Token */}
          <div className="rounded-lg border border-dashed border-border bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-1 font-medium text-foreground">
              <ExternalLink className="size-3" />
              Link único gerado por envio:
            </div>
            <p className="mt-1 font-mono text-[10px] text-primary truncate">
              https://ronaldomeira.com.br/imoveis/p/[token-opaco-seguro]
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={sending}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSend}
            disabled={sending}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
          >
            {sending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Preparando...
              </>
            ) : (
              <>
                <Send className="size-3.5" />
                Enviar no WhatsApp
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
