import { create } from 'zustand';

export type UserRole = 'student' | 'teacher' | 'creator' | 'admin';

interface AuthStore {
  userId: string | null;
  role: UserRole | null;
  isAuthenticated: boolean;
  setUser: (userId: string, role: UserRole) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthStore>((set: any) => ({
  userId: null,
  role: null,
  isAuthenticated: false,
  
  setUser: (userId: string, role: UserRole) =>
    set({
      userId,
      role,
      isAuthenticated: true,
    }),
  
  logout: () =>
    set({
      userId: null,
      role: null,
      isAuthenticated: false,
    }),
}));
