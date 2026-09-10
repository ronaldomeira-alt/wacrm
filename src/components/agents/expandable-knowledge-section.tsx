'use client'

import React, { useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Pencil,
  Trash2,
  Check,
  X,
  Plus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

interface ExpandableKnowledgeSectionProps {
  id: string
  title: string
  icon: React.ReactNode
  subtitle: string
  value: string
  onChange: (newValue: string) => void
  placeholder: string
  emptyPrompt: string
  addButtonText: string
  disabled?: boolean
  rows?: number
}

export function ExpandableKnowledgeSection({
  id,
  title,
  icon,
  subtitle,
  value,
  onChange,
  placeholder,
  emptyPrompt,
  addButtonText,
  disabled = false,
  rows = 6,
}: ExpandableKnowledgeSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [draftValue, setDraftValue] = useState(value)

  const hasContent = Boolean(value && value.trim().length > 0)

  const handleStartEdit = () => {
    setDraftValue(value)
    setIsEditing(true)
    setIsExpanded(true)
  }

  const handleSaveEdit = () => {
    onChange(draftValue.trim())
    setIsEditing(false)
  }

  const handleCancelEdit = () => {
    setDraftValue(value)
    setIsEditing(false)
  }

  const handleDelete = () => {
    const confirmDelete = window.confirm(
      `Tem certeza que deseja apagar o conteúdo de "${title}"?\n\nEsta alteração entrará em vigor ao salvar o empreendimento.`,
    )
    if (confirmDelete) {
      onChange('')
      setDraftValue('')
      setIsEditing(false)
      setIsExpanded(false)
    }
  }

  return (
    <div className="rounded-xl border border-border/80 bg-card p-3.5 sm:p-4 space-y-3 transition-all">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
            {icon}
          </div>
          <div className="min-w-0">
            <Label htmlFor={id} className="text-xs font-semibold text-foreground truncate block">
              {title}
            </Label>
          </div>
        </div>

        {/* Action buttons in header */}
        {!isEditing && hasContent && !disabled && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleStartEdit}
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
            >
              <Pencil className="h-3 w-3" />
              <span className="hidden sm:inline">Editar</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1"
            >
              <Trash2 className="h-3 w-3" />
              <span className="hidden sm:inline">Apagar</span>
            </Button>
          </div>
        )}
      </div>

      {/* Main Body */}
      {isEditing ? (
        <div className="space-y-2">
          <Textarea
            id={id}
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            placeholder={placeholder}
            rows={rows}
            disabled={disabled}
            className="text-xs sm:text-sm resize-y font-mono leading-relaxed bg-background"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCancelEdit}
              disabled={disabled}
              className="h-7 text-xs gap-1"
            >
              <X className="h-3 w-3" />
              Cancelar
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSaveEdit}
              disabled={disabled}
              className="h-7 text-xs gap-1 font-medium"
            >
              <Check className="h-3 w-3" />
              Concluir Edição
            </Button>
          </div>
        </div>
      ) : hasContent ? (
        <div className="space-y-2.5">
          {/* Content Viewer */}
          <div
            className={`rounded-lg border border-border/50 bg-background/50 p-3 transition-all ${
              isExpanded
                ? 'max-h-[380px] overflow-y-auto'
                : 'max-h-24 overflow-hidden relative'
            }`}
          >
            <p className="whitespace-pre-wrap text-xs sm:text-sm text-foreground/90 leading-relaxed font-normal">
              {value}
            </p>

            {/* Gradient overlay when collapsed */}
            {!isExpanded && (
              <div className="absolute bottom-0 inset-x-0 h-10 bg-gradient-to-t from-background/90 via-background/40 to-transparent pointer-events-none rounded-b-lg" />
            )}
          </div>

          {/* Toggle Expand Button */}
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
              className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground font-medium"
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" />
                  Ocultar conteúdo
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" />
                  Mostrar conteúdo completo
                </>
              )}
            </Button>

            <span className="text-[11px] text-muted-foreground font-mono">
              {value.length} caracteres
            </span>
          </div>
        </div>
      ) : (
        /* Empty State */
        <div className="rounded-lg border border-dashed border-border/80 bg-muted/20 p-4 text-center space-y-2">
          <p className="text-xs text-muted-foreground">{emptyPrompt}</p>
          {!disabled && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleStartEdit}
              className="h-7 text-xs gap-1"
            >
              <Plus className="h-3 w-3" />
              {addButtonText}
            </Button>
          )}
        </div>
      )}

      {/* Subtitle / Helper Info */}
      <p className="text-[11px] text-muted-foreground leading-normal">{subtitle}</p>
    </div>
  )
}
