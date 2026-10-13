/**
 * Toast Notification System
 * 
 * Uses HeroUI Toast for mutation error notifications.
 * Provides a simple API for showing toast messages.
 */

import { useCallback } from 'react';
import { toast } from '@heroui/react';

export interface ToastOptions {
  title?: string;
  description: string;
  variant?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
  timeout?: number;
}

export function useToast() {
  const showToast = useCallback((options: ToastOptions) => {
    toast(options.title ?? options.description, {
      description: options.title ? options.description : undefined,
      variant: options.variant ?? 'default',
      timeout: options.timeout ?? 5000,
    });
  }, []);

  const showError = useCallback((description: string, title?: string) => {
    toast.danger(title ?? 'Error', {
      description,
      timeout: 5000,
    });
  }, []);

  const showSuccess = useCallback((description: string, title?: string) => {
    toast.success(title ?? 'Success', {
      description,
      timeout: 3000,
    });
  }, []);

  const showWarning = useCallback((description: string, title?: string) => {
    toast.warning(title ?? 'Warning', {
      description,
      timeout: 5000,
    });
  }, []);

  const showInfo = useCallback((description: string, title?: string) => {
    toast.info(title ?? 'Info', {
      description,
      timeout: 3000,
    });
  }, []);

  return {
    showToast,
    showError,
    showSuccess,
    showWarning,
    showInfo,
  };
}
