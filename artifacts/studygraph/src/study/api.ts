import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Flashcard, GraphResponse, MasteryResponse, PlanDay, Quiz, SourceView, SubmitResponse, UnitDetail,
} from './types';

export async function xfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `Request failed (${res.status}).`;
    throw new Error(message);
  }
  return data as T;
}

export const masteryKey = (courseId: string) => ['x-mastery', courseId] as const;

export function useMastery(courseId: string) {
  return useQuery({ queryKey: masteryKey(courseId), queryFn: () => xfetch<MasteryResponse>(`/x/courses/${courseId}/mastery`), staleTime: 5_000 });
}

export function useGraph(courseId: string) {
  return useQuery({ queryKey: ['x-graph', courseId], queryFn: () => xfetch<GraphResponse>(`/x/courses/${courseId}/graph`), staleTime: 10_000 });
}

export function useUnit(unitId: string | null) {
  return useQuery({ queryKey: ['x-unit', unitId], enabled: !!unitId, queryFn: () => xfetch<UnitDetail>(`/x/units/${unitId}`), staleTime: 60_000 });
}

export function useSourceView(sourceId: string | null) {
  return useQuery({ queryKey: ['x-source-view', sourceId], enabled: !!sourceId, queryFn: () => xfetch<SourceView>(`/x/sources/${sourceId}/view`), staleTime: 30_000 });
}

export const sourcePageImageUrl = (sourceId: string, page: number, unitId?: string) =>
  `/api/x/sources/${sourceId}/page/${page}/image${unitId ? `?unitId=${encodeURIComponent(unitId)}` : ''}`;

export type QuizSettings = {
  mode: 'practice' | 'diagnostic' | 'mock' | 'chat';
  count?: number;
  difficulty?: 'easy' | 'medium' | 'hard' | 'mixed';
  types?: string[];
  topicId?: string;
  unitIds?: string[];
};

export type AccountSettings = {
  dailyGoalMinutes: number;
  reminderTime: string | null;
  remindersEnabled: boolean;
  language: 'en' | 'hi' | 'en-IN' | 'ta' | 'te' | 'bn' | 'mr';
  biggerText: boolean;
  dyslexiaFont: boolean;
  highContrast: boolean;
};
export const defaultAccountSettings: AccountSettings = {
  dailyGoalMinutes: 30, reminderTime: null, remindersEnabled: false,
  language: 'en', biggerText: false, dyslexiaFont: false, highContrast: false,
};
export const accountSettingsKey = ['account-settings'] as const;
export function useAccountSettings(enabled = true) {
  return useQuery({ queryKey: accountSettingsKey, queryFn: () => xfetch<AccountSettings>('/account/settings'), staleTime: 30_000, enabled });
}
export function useSaveAccountSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: AccountSettings) => xfetch<AccountSettings>('/account/settings', { method: 'PUT', body: JSON.stringify(settings) }),
    onSuccess: settings => { qc.setQueryData(accountSettingsKey, settings); },
  });
}

export type SavedPlan = {
  id: string;
  courseId: string;
  examDate: string;
  minutesPerDay: number;
  schedule: PlanDay[];
  completed: string[];
  savedAt: string;
};
export function useSavedPlans(courseId: string) {
  return useQuery({ queryKey: ['saved-plans', courseId], queryFn: () => xfetch<SavedPlan[]>(`/x/courses/${courseId}/plans`), staleTime: 10_000 });
}
export function useCreateSavedPlan(courseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plan: Omit<SavedPlan, 'id' | 'courseId' | 'savedAt'>) => xfetch<SavedPlan>(`/x/courses/${courseId}/plans`, { method: 'POST', body: JSON.stringify(plan) }),
    onSuccess: created => {
      qc.setQueryData<SavedPlan[]>(['saved-plans', courseId], current => [created, ...(current ?? []).filter(plan => plan.id !== created.id)]);
      void qc.invalidateQueries({ queryKey: ['saved-plans', courseId] });
    },
  });
}
export function useUpdateSavedPlan(courseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; completed: string[] }) => xfetch<SavedPlan>(`/x/courses/${courseId}/plans/${input.id}`, { method: 'PATCH', body: JSON.stringify({ completed: input.completed }) }),
    onSuccess: updated => {
      qc.setQueryData<SavedPlan[]>(['saved-plans', courseId], current => (current ?? []).map(plan => plan.id === updated.id ? updated : plan));
      void qc.invalidateQueries({ queryKey: ['saved-plans', courseId] });
    },
  });
}

export function useCreateQuiz(courseId: string) {
  return useMutation({
    mutationFn: (settings: QuizSettings) =>
      xfetch<{ quiz: Quiz }>(`/x/courses/${courseId}/quiz`, { method: 'POST', body: JSON.stringify(settings) }).then(r => r.quiz),
  });
}

export function useSubmitQuiz(courseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { quizId: string; answers: { questionId: string; answer: string | number | null }[] }) =>
      xfetch<SubmitResponse>(`/x/quizzes/${input.quizId}/submit`, { method: 'POST', body: JSON.stringify({ answers: input.answers }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: masteryKey(courseId) });
      void qc.invalidateQueries({ queryKey: ['x-graph', courseId] });
    },
  });
}

export function useFlashcards(courseId: string) {
  return useMutation({
    mutationFn: (count: number) =>
      xfetch<{ cards: Flashcard[] }>(`/x/courses/${courseId}/flashcards`, { method: 'POST', body: JSON.stringify({ count }) }).then(r => r.cards),
  });
}

export function usePlan(courseId: string) {
  return useMutation({
    mutationFn: (input: { examDate: string; minutesPerDay: number }) =>
      xfetch<{ examDate: string; days: number; minutesPerDay: number; schedule: PlanDay[] }>(`/x/courses/${courseId}/plan?examDate=${encodeURIComponent(input.examDate)}&minutesPerDay=${input.minutesPerDay}`),
  });
}

export async function sendChatSignal(courseId: string, unitIds: string[]) {
  try {
    await xfetch(`/x/courses/${courseId}/chat-signal`, { method: 'POST', body: JSON.stringify({ unitIds }) });
  } catch { /* evidence is best-effort and must never break the chat */ }
}

export function askOutsideKnowledge(courseId: string, question: string) {
  return xfetch<{ answer: string; disclaimer: string }>(`/x/courses/${courseId}/outside-knowledge`, { method: 'POST', body: JSON.stringify({ question }) });
}

export function extractPhotoQuestion(courseId: string, imageDataUrl: string) {
  return xfetch<{ question: string }>(`/courses/${courseId}/tutor/photo-question`, {
    method: 'POST',
    body: JSON.stringify({ imageDataUrl }),
  });
}
