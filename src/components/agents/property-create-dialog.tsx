'use client';

import { useState, useRef } from 'react';
import { toast } from 'sonner';
import {
  Building2,
  FileText,
  Upload,
  Sparkles,
  Loader2,
  X,
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
  const [subjectiveKnowledge, setSubjectiveKnowledge] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [stepLabel, setStepLabel] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setName('');
    setStage('lancamento');
    setSubjectiveKnowledge('');
    setSelectedFile(null);
    setStepLabel(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Por favor, selecione apenas arquivos em formato PDF.');
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      toast.error('O arquivo selecionado excede o limite máximo de 50MB.');
      return;
    }

    setSelectedFile(file);
  };

  const handleRemoveFile = () => {
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Informe o nome do empreendimento.');
      return;
    }

    setSaving(true);
    setStepLabel('Criando empreendimento...');

    try {
      // 1. Create property and initial context
      const res = await fetch('/api/ai/properties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          stage,
          subjective_knowledge: subjectiveKnowledge.trim() || null,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao criar empreendimento');
      }

      const createdProperty: PropertyWithAiContext = data.property;

      // 2. If a PDF file was selected, upload and index it immediately
      if (selectedFile && createdProperty?.id) {
        setStepLabel('Extraindo texto e indexando Book em PDF...');
        const formData = new FormData();
        formData.append('file', selectedFile);

        const uploadRes = await fetch(`/api/ai/properties/${createdProperty.id}/book`, {
          method: 'POST',
          body: formData,
        });

        const uploadData = await uploadRes.json().catch(() => ({}));
        if (!uploadRes.ok) {
          toast.warning(
            `Empreendimento criado, mas houve um aviso no PDF: ${uploadData.error || 'Erro ao processar PDF'}. Você pode reenviá-lo depois.`,
          );
        } else {
          toast.success(
            `Empreendimento criado com sucesso e Book indexado (${uploadData.pageCount ?? ''} páginas)!`,
          );
        }
      } else {
        toast.success('Empreendimento cadastrado com sucesso!');
      }

      resetForm();
      onOpenChange(false);
      onCreated(createdProperty);
    } catch (err: any) {
      toast.error(err.message || 'Falha ao cadastrar empreendimento');
    } finally {
      setSaving(false);
      setStepLabel(null);
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
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            Adicionar Novo Empreendimento
          </DialogTitle>
          <DialogDescription className="text-xs">
            Cadastre o empreendimento com seu estágio, anotações práticas de atendimento e o Book Técnico (PDF) para consulta da IA.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Nome e Estágio */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2 space-y-1.5">
              <Label htmlFor="prop-name" className="text-xs font-medium">
                Nome do Empreendimento <span className="text-destructive">*</span>
              </Label>
              <Input
                id="prop-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Residencial Aurora Bessa"
                disabled={saving}
                className="h-9 text-sm"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prop-stage" className="text-xs font-medium">
                Estágio da Obra
              </Label>
              <Select
                value={stage}
                onValueChange={(val) => setStage(val as PropertyStage)}
                disabled={saving}
              >
                <SelectTrigger id="prop-stage" className="h-9 text-sm">
                  <SelectValue />
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

          {/* Anotações Práticas / Visão do Corretor */}
          <div className="space-y-1.5">
            <Label htmlFor="prop-subjective" className="text-xs font-medium flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Anotações Práticas / Visão do Corretor (Conhecimento Subjetivo)
            </Label>
            <Textarea
              id="prop-subjective"
              value={subjectiveKnowledge}
              onChange={(e) => setSubjectiveKnowledge(e.target.value)}
              placeholder="Digite dicas e informações práticas que a IA deve saber sobre este empreendimento. Ex:
- Previsão de entrega para Dezembro de 2026.
- A área de lazer é entregue 100% equipada e decorada.
- Vagas de garagem rotativas com sorteio bienal.
- Aceita animais de grande porte no pet place.
- Fica a 200 metros da praia, próximo ao Bessa Shopping."
              rows={5}
              disabled={saving}
              className="text-sm resize-y"
            />
            <p className="text-[11px] text-muted-foreground">
              A IA usa estas notas para responder a dúvidas práticas do dia a dia com linguagem natural.
            </p>
          </div>

          {/* Upload do Book Técnico (PDF) */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-primary" />
              Book Técnico / Apresentação (Arquivo PDF)
            </Label>

            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={handleFileChange}
              disabled={saving}
            />

            {selectedFile ? (
              <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-foreground truncate">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • Pronto para indexar
                    </p>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleRemoveFile}
                  disabled={saving}
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive shrink-0"
                  title="Remover arquivo"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 p-5 text-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary mb-2">
                  <Upload className="h-4 w-4" />
                </div>
                <p className="text-xs font-medium text-foreground">
                  Clique aqui para selecionar o Book em PDF
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  PDF com plantas, áreas, acabamento e especificações (até 50MB).
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2.5 h-7 text-xs"
                  disabled={saving}
                >
                  <Plus className="mr-1 h-3 w-3" /> Selecionar Arquivo PDF
                </Button>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancelar
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {stepLabel || 'Salvando...'}
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
