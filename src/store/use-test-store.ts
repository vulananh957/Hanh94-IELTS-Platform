import { create } from 'zustand';

interface TestSession {
  testId: string;
  startTime: number;
  currentQuestion: number;
  answers: Record<number, string | null>;
  timeRemaining: number;
}

interface TestStore {
  currentSession: TestSession | null;
  startTest: (testId: string, duration: number, totalQuestions: number) => void;
  submitAnswer: (questionId: number, answer: string) => void;
  nextQuestion: () => void;
  endTest: () => void;
}

export const useTestStore = create<TestStore>((set: any, get: any) => ({
  currentSession: null,
  
  startTest: (testId: string, duration: number, totalQuestions: number) =>
    set({
      currentSession: {
        testId,
        startTime: Date.now(),
        currentQuestion: 0,
        answers: Object.fromEntries(
          Array.from({ length: totalQuestions }).map((_, i) => [i, null])
        ),
        timeRemaining: duration * 60, // Convert minutes to seconds
      },
    }),
  
  submitAnswer: (questionId: number, answer: string) => {
    const session = get().currentSession;
    if (session) {
      set({
        currentSession: {
          ...session,
          answers: {
            ...session.answers,
            [questionId]: answer,
          },
        },
      });
    }
  },
  
  nextQuestion: () => {
    const session = get().currentSession;
    if (session) {
      set({
        currentSession: {
          ...session,
          currentQuestion: session.currentQuestion + 1,
        },
      });
    }
  },
  
  endTest: () =>
    set({
      currentSession: null,
    }),
}));
