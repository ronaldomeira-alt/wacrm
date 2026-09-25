import { describe, it, expect } from 'vitest';
import { calculateCommercialPriority } from './priority';

describe('Commercial Priority — 35/25/15/15/10 Canonical Formula', () => {
  it('1. Match 100 contribui exatamente 35 pontos', () => {
    const priority = calculateCommercialPriority({
      matchScore: 100,
      aiScore: 0,
      profileMaturity: 0,
      recentInteractionDays: 999,
      sharesCount: 0,
      sharesOpenedCount: 0,
      hasInterestClick: false,
    });
    expect(priority).toBe(35);
  });

  it('2. AI Score 10 contribui exatamente 25 pontos', () => {
    const priority = calculateCommercialPriority({
      matchScore: 0,
      aiScore: 10,
      profileMaturity: 0,
      recentInteractionDays: 999,
      sharesCount: 0,
      sharesOpenedCount: 0,
      hasInterestClick: false,
    });
    expect(priority).toBe(25);
  });

  it('3. Maturidade 100 contribui exatamente 15 pontos', () => {
    const priority = calculateCommercialPriority({
      matchScore: 0,
      aiScore: 0,
      profileMaturity: 100,
      recentInteractionDays: 999,
      sharesCount: 0,
      sharesOpenedCount: 0,
      hasInterestClick: false,
    });
    expect(priority).toBe(15);
  });

  it('4. Recência máxima contribui exatamente 15 pontos', () => {
    const priority = calculateCommercialPriority({
      matchScore: 0,
      aiScore: 0,
      profileMaturity: 0,
      recentInteractionDays: 1, // <= 1 dia -> 10 * 1.5 = 15
      sharesCount: 0,
      sharesOpenedCount: 0,
      hasInterestClick: false,
    });
    expect(priority).toBe(15);
  });

  it('5. Engajamento máximo contribui exatamente 10 pontos', () => {
    const priority = calculateCommercialPriority({
      matchScore: 0,
      aiScore: 0,
      profileMaturity: 0,
      recentInteractionDays: 999,
      sharesCount: 4,
      sharesOpenedCount: 4, // 4 * 2 = 8 -> cap 7 + 8 (interest) = 15 -> 15 * (10/15) = 10
      hasInterestClick: true,
    });
    expect(priority).toBe(10);
  });

  it('6. Soma máxima de todos os componentes positivos antes de fadiga = 100', () => {
    const maxPriority = calculateCommercialPriority({
      matchScore: 100,
      aiScore: 10,
      profileMaturity: 100,
      recentInteractionDays: 1,
      sharesCount: 5,
      sharesOpenedCount: 5,
      hasInterestClick: true,
    });
    expect(maxPriority).toBe(100);
  });

  it('7. Fadiga reduz a prioridade sem alterar os componentes individuais', () => {
    const base = calculateCommercialPriority({
      matchScore: 80,
      aiScore: 5,
      profileMaturity: 70,
      sharesCount: 0,
      sharesOpenedCount: 0,
    });
    const withFatigue = calculateCommercialPriority({
      matchScore: 80,
      aiScore: 5,
      profileMaturity: 70,
      sharesCount: 5,
      sharesOpenedCount: 0, // 5 não abertos -> penalidade 15
    });
    expect(withFatigue).toBe(base - 15);
  });

  it('8. Dois leads com mesmo Match mas temperaturas diferentes têm prioridades diferentes', () => {
    const leadWarm = calculateCommercialPriority({ matchScore: 80, aiScore: 8, profileMaturity: 70 });
    const leadCold = calculateCommercialPriority({ matchScore: 80, aiScore: 2, profileMaturity: 70 });
    expect(leadWarm).toBeGreaterThan(leadCold);
    expect(leadWarm - leadCold).toBe((8 - 2) * 2.5); // 15 pontos de diferença
  });

  it('9. Dois leads com mesmo Match/temperatura mas maturidades diferentes têm prioridades diferentes', () => {
    const leadMature = calculateCommercialPriority({ matchScore: 80, aiScore: 5, profileMaturity: 90 });
    const leadImmature = calculateCommercialPriority({ matchScore: 80, aiScore: 5, profileMaturity: 70 });
    expect(leadMature).toBeGreaterThan(leadImmature);
    expect(leadMature - leadImmature).toBe(3); // (90 - 70) * 0.15 = 3
  });

  it('10. Recência e engajamento alteram apenas a prioridade, sem alterar matchScore do input', () => {
    const input = {
      matchScore: 85,
      aiScore: 7,
      profileMaturity: 80,
      recentInteractionDays: 1,
      hasInterestClick: true,
    };
    const priority = calculateCommercialPriority(input);
    expect(priority).toBeGreaterThan(input.matchScore * 0.35);
    expect(input.matchScore).toBe(85); // Imutabilidade preservada
  });
});
