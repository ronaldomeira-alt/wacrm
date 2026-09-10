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
  const [isDragging, setIsDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stepLabel, setStepLabel] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setName('');
    setStage('lancamento');
    setSubjectiveKnowledge('');
    setSelectedFile(null);
    setIsDragging(false);
    setSaving(false);
    setStepLabel(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const processFile = (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      toast.error('Por favor, selecione apenas arquivos em formato PDF.');
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      toast.error('O arquivo PDF selecionado excede o limite máximo de 50MB.');
      return;
    }

    setSelectedFile(file);
    toast.success(`Arquivo "${file.name}" pronto para envio!`);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const handleRemoveFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Por favor, informe o nome do empreendimento.');
      return;
    }

    setSaving(true);
    setStepLabel('1/2 Criando empreendimento no banco de dados...');

    try {
      // 1. Create property and initial context (with subjective knowledge indexed)
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
        setStepLabel('2/2 Extraindo texto e indexando páginas do Book no RAG...');
        const formData = new FormData();
        formData.append('file', selectedFile);

        const uploadRes = await fetch(`/api/ai/properties/${createdProperty.id}/book`, {
          method: 'POST',
          body: formData,
        });

        const uploadData = await uploadRes.json().catch(() => ({}));
        if (!uploadRes.ok) {
          toast.warning(
            `Empreendimento criado! Porém houve um aviso na leitura do PDF: ${uploadData.error || 'Não foi possível extrair texto'}. Você pode anexar outro PDF depois.`,
          );
        } else {
          toast.success(
            `Empreendimento cadastrado e Book indexado com sucesso (${uploadData.pageCount ?? ''} páginas)!`,
          );
        }
      } else {
        toast.success('Empreendimento cadastrado com sucesso!');
      }

      resetForm();
      onOpenChange(false);
      onCreated(createdProperty);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao cadastrar empreendimento';
      toast.error(msg);
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
      <DialogContent className="w-full sm:max-w-2xl md:max-w-3xl max-h-[90vh] overflow-y-auto p-6">
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-base font-semibold flex items-center gap-2 text-foreground">
            <Building2 className="h-5 w-5 text-primary" />
            Adicionar Novo Empreendimento
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Cadastre o empreendimento, defina o estágio, adicione as anotações práticas do corretor e anexe o Book Técnico (PDF) para a IA.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Nome e Estágio rigorosamente alinhados lado a lado com mesma altura */}
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

          {/* Visão do Corretor / Conhecimento Subjetivo */}
          <div className="space-y-1.5">
            <Label
              htmlFor="create-prop-subjective"
              className="text-xs font-medium text-foreground flex items-center gap-1.5"
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Visão do Corretor / Conhecimento Subjetivo
            </Label>
            <Textarea
              id="create-prop-subjective"
              value={subjectiveKnowledge}
              onChange={(e) => setSubjectiveKnowledge(e.target.value)}
              placeholder="Digite ou escreva aqui detalhes e dicas práticas que a IA deve saber sobre este empreendimento."
              rows={4}
              disabled={saving}
              className="text-sm resize-y"
            />
            <p className="text-[11px] text-muted-foreground">
              Anotações e percepções práticas que a IA consulta exclusivamente ao atender interessados neste empreendimento.
            </p>
          </div>

          {/* Upload do Book Técnico (PDF) */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-primary" />
              Book Técnico / Apresentação (Arquivo PDF)
            </Label>

            <input
              id="create-prop-book-file"
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
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <FileCheckIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-foreground truncate">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB • Pronto para indexar no RAG
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
              <label
                htmlFor="create-prop-book-file"
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-5 text-center cursor-pointer transition-all ${
                  isDragging
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-muted/20 hover:border-primary/50 hover:bg-primary/5'
                }`}
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary mb-2">
                  <Upload className="h-4 w-4" />
                </div>
                <p className="text-xs font-semibold text-foreground">
                  Clique para selecionar o Book em PDF ou arraste o arquivo aqui
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Plantas, metragens, acabamento e ficha técnica (arquivo PDF de até 50MB)
                </p>
                <span className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1 text-xs font-medium text-foreground shadow-sm">
                  <Plus className="h-3.5 w-3.5 text-primary" /> Escolher Arquivo PDF
                </span>
              </label>
            )}
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

function FileCheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="m9 15 2 2 4-4" />
    </svg>
  );
}
