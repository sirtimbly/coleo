/**
 * MessageComposer - Panel for sending messages to Brain or Arms
 * 
 * Opens with 'N' key globally
 * - Default mode: Send message to Brain for task distribution
 * - Direct mode: Send prompt directly to a specific arm
 */
import { useState, useEffect, useRef } from 'react';
import { X, Send, Brain, Cpu, ChevronDown, Reply, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { api, type Arm, type TaskAttachment } from '@/lib/api';

interface MessageComposerProps {
  onClose: () => void;
  replyTo?: {
    messageId: string;
    threadId?: string;
    from: string;
    subject: string;
    body: string;
  };
}

type MessageMode = 'brain' | 'arm';

interface ArmOption {
  id: string;
  name: string;
  status: Arm['status'];
  domain: string;
}

export function MessageComposer({ onClose, replyTo }: MessageComposerProps) {
  const [mode, setMode] = useState<MessageMode>('brain');
  const [message, setMessage] = useState('');
  const [selectedArmId, setSelectedArmId] = useState<string>('');
  const [arms, setArms] = useState<ArmOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [isReply, setIsReply] = useState(false);
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Set up reply context when the composer opens with replyTo
  useEffect(() => {
    if (replyTo) {
      setIsReply(true);
      setMode('brain'); // Replies go to brain
      setAttachments([]);
      setError(null);
      // Pre-fill with quoted original message
      const quotedBody = replyTo.body
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
      setMessage(`\n\n---\nIn reply to: ${replyTo.subject}\nFrom: ${replyTo.from}\n\n${quotedBody}`);
    } else {
      setIsReply(false);
      setMessage('');
      setAttachments([]);
      setError(null);
    }
  }, [replyTo]);

  // Load arms when the composer opens
  useEffect(() => {
    void loadArms();
    const focusTimer = window.setTimeout(() => textareaRef.current?.focus(), 100);
    return () => window.clearTimeout(focusTimer);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Handle escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const loadArms = async () => {
    setIsLoading(true);
    try {
      const result = await api.listArms();
      const armOptions: ArmOption[] = result.arms.map(arm => ({
        id: arm.id,
        name: arm.name,
        status: arm.status,
        domain: arm.domain,
      }));
      setArms(armOptions);
      
      // Auto-select first running arm if available
      const runningArm = armOptions.find(a => a.status === 'idle' || a.status === 'busy');
      if (runningArm) {
        setSelectedArmId(runningArm.id);
      }
    } catch (err) {
      console.error('Failed to load arms:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!message.trim()) return;
    
    setIsSending(true);
    setError(null);
    
    try {
      if (mode === 'brain') {
        // Send to brain via dedicated endpoint
        await api.sendBrainMessage({ 
          message,
          inReplyTo: isReply && replyTo ? replyTo.messageId : undefined,
          threadId: isReply && replyTo ? replyTo.threadId : undefined,
          subject: isReply && replyTo ? `Re: ${replyTo.subject}` : undefined,
          attachments,
        });
      } else {
        // Send directly to arm
        if (!selectedArmId) {
          setError('Please select an arm');
          setIsSending(false);
          return;
        }
        
        await api.sendArmPrompt({
          armId: selectedArmId,
          prompt: message,
          attachments,
        });
      }
      
      // Success - clear and close
      setMessage('');
      setAttachments([]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Submit on Cmd/Ctrl + Enter
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      setError('Only image uploads are supported');
      return;
    }

    setIsUploading(true);
    setError(null);

    try {
      const uploaded: TaskAttachment[] = [];
      for (const file of imageFiles) {
        const response = await api.uploadImage(file);
        uploaded.push(response.attachment);
      }
      setAttachments((current) => [...current, ...uploaded]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload image');
    } finally {
      setIsUploading(false);
    }
  };

  const removeAttachment = (uploadId: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.uploadId !== uploadId));
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      await uploadFiles(e.dataTransfer.files);
    }
  };

  const getStatusColor = (status: Arm['status']) => {
    switch (status) {
      case 'idle': return 'text-success';
      case 'busy': return 'text-warning';
      case 'paused': return 'text-accent';
      case 'error': return 'text-danger';
      case 'stopped': return 'text-muted-foreground';
      default: return 'text-muted-foreground';
    }
  };

  const getStatusDot = (status: Arm['status']) => {
    const color = getStatusColor(status).replace('text-', 'bg-');
    return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
  };

  const selectedArm = arms.find(a => a.id === selectedArmId);

  return (
    <div className="flex min-h-full w-full items-start justify-center bg-surface p-3 sm:p-5">
      <div className="flex min-h-[min(42rem,100%)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-overlay text-foreground shadow-xl">
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            {/* Mode selector */}
            <div className="flex items-center rounded-lg bg-surface-secondary p-1">
              <button
                onClick={() => setMode('brain')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  mode === 'brain'
                    ? 'bg-purple-600 text-white'
                    : 'text-muted-foreground hover:bg-surface-tertiary hover:text-foreground'
                }`}
              >
                <Brain className="w-4 h-4" />
                Brain
              </button>
              <button
                onClick={() => setMode('arm')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  mode === 'arm'
                    ? 'bg-cyan-600 text-white'
                    : 'text-muted-foreground hover:bg-surface-tertiary hover:text-foreground'
                }`}
              >
                <Cpu className="w-4 h-4" />
                Direct
              </button>
            </div>
            
            {/* Arm selector (only in arm mode) */}
            {mode === 'arm' && (
              <div className="relative min-w-0" ref={dropdownRef}>
                <button
                  onClick={() => setShowDropdown(!showDropdown)}
                  disabled={isLoading}
                  className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-surface-secondary px-3 py-1.5 text-sm transition-colors hover:bg-surface-tertiary"
                >
                  {isLoading ? (
                    <span className="text-muted-foreground">Loading...</span>
                  ) : selectedArm ? (
                    <>
                      {getStatusDot(selectedArm.status)}
                      <span className="truncate text-foreground">{selectedArm.name}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Select arm...</span>
                  )}
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </button>
                
                {showDropdown && (
                  <div className="absolute left-0 top-full z-10 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-overlay shadow-xl">
                    {arms.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">No arms available</div>
                    ) : (
                      <div className="max-h-48 overflow-y-auto">
                        {arms.map(arm => (
                          <button
                            key={arm.id}
                            onClick={() => {
                              setSelectedArmId(arm.id);
                              setShowDropdown(false);
                            }}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-secondary ${
                              selectedArmId === arm.id ? 'bg-surface-secondary' : ''
                            }`}
                          >
                            {getStatusDot(arm.status)}
                            <span className="flex-1 text-foreground">{arm.name}</span>
                            <span className={`text-xs ${getStatusColor(arm.status)}`}>
                              {arm.status}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-secondary hover:text-foreground"
            aria-label="Close new message"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Body */}
        <div className="min-h-0 overflow-y-auto p-4">
          {/* Description */}
          <p className="mb-3 text-sm text-muted-foreground">
            {isReply ? (
              <>Replying to: <span className="font-medium text-foreground">{replyTo?.subject}</span></>
            ) : mode === 'brain' ? (
              <>Send a message to the Brain. It will parse your intent and route to the appropriate arm(s).</>
            ) : (
              <>Send a prompt directly to the selected arm. Use this for specific instructions or to unblock an arm.</>
            )}
          </p>
          
          {/* Text input */}
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === 'brain' 
              ? "Describe your task, feature request, or instruction..."
              : "Enter a prompt for the selected arm..."
            }
            className="h-40 w-full resize-none rounded-lg border border-border bg-surface-secondary px-3 py-2 text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) {
                void uploadFiles(e.target.files);
              }
              e.target.value = '';
            }}
          />

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragOver(false);
            }}
            onDrop={(e) => {
              void handleDrop(e);
            }}
            className={`mt-3 rounded-lg border border-dashed px-3 py-3 transition-colors ${
              isDragOver ? 'border-accent bg-accent/10' : 'border-border bg-surface-secondary/60'
            }`}
          >
            <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2 text-sm text-foreground">
                {isUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-accent" />
                ) : (
                  <ImagePlus className="h-4 w-4 text-accent" />
                )}
                <span>Drag screenshots here or upload images to include with the prompt.</span>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:border-accent hover:bg-surface-tertiary disabled:cursor-not-allowed disabled:opacity-50"
              >
                Choose images
              </button>
            </div>

            {attachments.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {attachments.map((attachment) => (
                  <div key={attachment.uploadId} className="overflow-hidden rounded-lg border border-border bg-surface">
                    <img
                      src={attachment.contentUrl}
                      alt={attachment.filename}
                      className="h-28 w-full object-cover"
                    />
                    <div className="flex items-center justify-between gap-2 px-2 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-foreground">{attachment.filename}</p>
                        <p className="text-[11px] text-muted-foreground">{Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeAttachment(attachment.uploadId)}
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-secondary hover:text-danger"
                        aria-label={`Remove ${attachment.filename}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          
          {/* Error message */}
          {error && (
            <p className="mt-2 text-sm text-danger">{error}</p>
          )}
        </div>
        
        {/* Footer */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-secondary/60 px-4 py-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            Press <kbd className="rounded bg-surface-tertiary px-1.5 py-0.5 text-foreground">Cmd</kbd>+<kbd className="rounded bg-surface-tertiary px-1.5 py-0.5 text-foreground">Enter</kbd> to send
          </span>
          
          <button
            onClick={handleSubmit}
            disabled={isSending || isUploading || !message.trim() || (mode === 'arm' && !selectedArmId)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-colors ${
              mode === 'brain'
                ? 'bg-purple-600 hover:bg-purple-500 disabled:bg-purple-600/50'
                : 'bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50'
            } text-white disabled:cursor-not-allowed`}
          >
            {isSending ? (
              <>Sending...</>
            ) : isReply ? (
              <>
                <Reply className="w-4 h-4" />
                Send Reply
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                {mode === 'brain' ? 'Send to Brain' : 'Send to Arm'}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
