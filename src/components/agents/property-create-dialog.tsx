'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Building2,
  FileText,
  Sparkles,
  Loader2,
  Plus,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { STAGE_LABELS } from './property-knowledge-detail-dialog';
import type { PropertyStage, PropertyWithAiContext } from '@/types';

interface PropertyCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (newProp?: PropertyWithAiContext) => void;
}

export function PropertyCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: PropertyCreateDialogProps) {
  const [name, setName] = useState('');
  const [stage, setStage] = useState<PropertyStage>('lancamento');
  const [bookSummary, setBookSummary] = useState('');
  const [subjectiveKnowledge, setSubjectiveKnowledge] = useState('');
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setName('');
    setStage('lancamento');
    setBookSummary('');
    setSubjectiveKnowledge('');
    setSaving(false);
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Por favor, informe o nome do empreendimento.');
      return;
    }

    setSaving(true);

    try {
      const res = await fetch('/api/ai/properties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          stage,
          book_summary: bookSummary.trim() || null,
          subjective_knowledge: subjectiveKnowledge.trim() || null,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao criar empreendimento');
      }

      const createdProperty: PropertyWithAiContext = data.property;

      if (data.warning) {
        toast.warning(data.warning);
      } else {
        toast.success('Empreendimento cadastrado e conhecimento indexado com sucesso!');
      }
      resetForm();
      onOpenChange(false);
      onCreated(createdProperty);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao cadastrar empreendimento';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!saving) {
          if (!v) resetForm();
          onOpenChange(v);
        }
      }}
    >
      <DialogContent className="w-full sm:max-w-2xl md:max-w-3xl max-h-[90vh] overflow-y-auto p-6">
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-base font-semibold flex items-center gap-2 text-foreground">
            <Building2 className="h-5 w-5 text-primary" />
            Adicionar Novo Empreendimento
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Cadastre o empreendimento e forneça a ficha técnica estruturada do Book e suas anotações práticas para a IA.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Nome e Estágio alinhados lado a lado */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-start">
            <div className="sm:col-span-7 space-y-1.5">
              <Label
                htmlFor="create-prop-name"
                className="text-xs font-medium text-foreground flex items-center h-5 leading-none"
              >
                Nome do Empreendimento <span className="text-destructive ml-0.5">*</span>
              </Label>
              <Input
                id="create-prop-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Residencial Aurora Bessa"
                disabled={saving}
                className="h-9 text-sm"
                autoFocus
              />
            </div>

            <div className="sm:col-span-5 space-y-1.5">
              <Label
                htmlFor="create-prop-stage"
                className="text-xs font-medium text-foreground flex items-center h-5 leading-none whitespace-nowrap"
              >
                Estágio do Empreendimento
              </Label>
              <Select
                value={stage}
                onValueChange={(val) => setStage(val as PropertyStage)}
                disabled={saving}
              >
                <SelectTrigger id="create-prop-stage" className="h-9 text-sm w-full">
                  <SelectValue>{STAGE_LABELS[stage]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(STAGE_LABELS).map(([k, label]) => (
                    <SelectItem key={k} value={k} className="text-sm">
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Ficha Técnica / Resumo do Book */}
          <div className="space-y-1.5">
            <Label
              htmlFor="create-prop-book-summary"
              className="text-xs font-medium text-foreground flex items-center gap-1.5"
            >
              <FileText className="h-3.5 w-3.5 text-primary" />
              Ficha Técnica / Resumo do Book Técnico
            </Label>
            <Textarea
              id="create-prop-book-summary"
              value={bookSummary}
              onChange={(e) => setBookSummary(e.target.value)}
              placeholder="Cole aqui o resumo completo gerado pela IA ou a ficha técnica do Book: localização exata, tipologias, metragens, quantidade de quartos/suítes, itens da área de lazer, acabamentos, diferenciais construtivos e previsão de entrega."
              rows={5}
              disabled={saving}
              className="text-sm resize-y"
            />
            <p className="text-[11px] text-muted-foreground">
              Dica: Você pode pedir para o ChatGPT/Claude resumir o Book PDF em tópicos estruturados e colar aqui. A IA do CRM usará estes dados para responder dúvidas técnicas dos clientes com máxima precisão.
            </p>
          </div>

          {/* Visão do Corretor / Dicas Práticas */}
          <div className="space-y-1.5">
            <Label
              htmlFor="create-prop-subjective"
              className="text-xs font-medium text-foreground flex items-center gap-1.5"
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Visão do Corretor / Dicas Práticas
            </Label>
            <Textarea
              id="create-prop-subjective"
              value={subjectiveKnowledge}
              onChange={(e) => setSubjectiveKnowledge(e.target.value)}
              placeholder="Digite argumentos de venda, perfil do comprador ideal (investidor, família, veraneio), pontos fortes da região, dicas para quebrar objeções e orientações práticas para a IA."
              rows={3}
              disabled={saving}
              className="text-sm resize-y"
            />
            <p className="text-[11px] text-muted-foreground">
              Anotações e percepções comerciais consultadas exclusivamente no atendimento aos interessados neste empreendimento.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="h-9 text-xs"
          >
            Cancelar
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={saving} className="h-9 text-xs font-medium">
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Salvando e Indexando...
              </>
            ) : (
              <>
                <Plus className="mr-1.5 h-4 w-4" />
                Criar Empreendimento
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
