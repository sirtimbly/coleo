/**
 * MessageModal - Global modal for sending messages to Brain or Arms
 * 
 * Opens with 'N' key globally
 * - Default mode: Send message to Brain for task distribution
 * - Direct mode: Send prompt directly to a specific arm
 */
import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Send, Brain, Cpu, ChevronDown, Reply } from 'lucide-react';
import { api, type Arm } from '@/lib/api';

interface MessageModalProps {
  isOpen: boolean;
  onClose: () => void;
  replyTo?: {
    messageId: string;
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

export function MessageModal({ isOpen, onClose, replyTo }: MessageModalProps) {
  const [mode, setMode] = useState<MessageMode>('brain');
  const [message, setMessage] = useState('');
  const [selectedArmId, setSelectedArmId] = useState<string>('');
  const [arms, setArms] = useState<ArmOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [isReply, setIsReply] = useState(false);
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Set up reply context when modal opens with replyTo
  useEffect(() => {
    if (isOpen && replyTo) {
      setIsReply(true);
      setMode('brain'); // Replies go to brain
      // Pre-fill with quoted original message
      const quotedBody = replyTo.body
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
      setMessage(`\n\n---\nIn reply to: ${replyTo.subject}\nFrom: ${replyTo.from}\n\n${quotedBody}`);
    } else if (isOpen) {
      setIsReply(false);
      setMessage('');
    }
  }, [isOpen, replyTo]);

  // Load arms when modal opens
  useEffect(() => {
    if (isOpen) {
      loadArms();
      // Focus textarea after a brief delay for animation
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [isOpen]);

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
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

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
          subject: isReply && replyTo ? `Re: ${replyTo.subject}` : undefined
        });
      } else {
        // Send directly to arm
        if (!selectedArmId) {
          setError('Please select an arm');
          setIsSending(false);
          return;
        }
        
        const response = await fetch(`/api/arms/${selectedArmId}/prompt`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': api.getApiKey() || '',
          },
          body: JSON.stringify({ prompt: message }),
        });
        
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Failed to send' }));
          throw new Error(err.error || err.message || 'Failed to send prompt');
        }
      }
      
      // Success - clear and close
      setMessage('');
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

  const getStatusColor = (status: Arm['status']) => {
    switch (status) {
      case 'idle': return 'text-green-400';
      case 'busy': return 'text-yellow-400';
      case 'paused': return 'text-blue-400';
      case 'error': return 'text-red-400';
      case 'stopped': return 'text-zinc-500';
      default: return 'text-zinc-400';
    }
  };

  const getStatusDot = (status: Arm['status']) => {
    const color = getStatusColor(status).replace('text-', 'bg-');
    return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
  };

  const selectedArm = arms.find(a => a.id === selectedArmId);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative w-full max-w-2xl mx-4 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <div className="flex items-center gap-3">
            {/* Mode selector */}
            <div className="flex items-center bg-zinc-800 rounded-lg p-1">
              <button
                onClick={() => setMode('brain')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  mode === 'brain'
                    ? 'bg-purple-600 text-white'
                    : 'text-zinc-400 hover:text-white'
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
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Cpu className="w-4 h-4" />
                Direct
              </button>
            </div>
            
            {/* Arm selector (only in arm mode) */}
            {mode === 'arm' && (
              <div className="relative" ref={dropdownRef}>
                <button
                  onClick={() => setShowDropdown(!showDropdown)}
                  disabled={isLoading}
                  className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 rounded-lg text-sm transition-colors"
                >
                  {isLoading ? (
                    <span className="text-zinc-400">Loading...</span>
                  ) : selectedArm ? (
                    <>
                      {getStatusDot(selectedArm.status)}
                      <span className="text-white">{selectedArm.name}</span>
                    </>
                  ) : (
                    <span className="text-zinc-400">Select arm...</span>
                  )}
                  <ChevronDown className="w-4 h-4 text-zinc-400" />
                </button>
                
                {showDropdown && (
                  <div className="absolute top-full left-0 mt-1 w-64 bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl overflow-hidden z-10">
                    {arms.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-zinc-400">No arms available</div>
                    ) : (
                      <div className="max-h-48 overflow-y-auto">
                        {arms.map(arm => (
                          <button
                            key={arm.id}
                            onClick={() => {
                              setSelectedArmId(arm.id);
                              setShowDropdown(false);
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-zinc-700 transition-colors ${
                              selectedArmId === arm.id ? 'bg-zinc-700' : ''
                            }`}
                          >
                            {getStatusDot(arm.status)}
                            <span className="text-white flex-1">{arm.name}</span>
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
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-white rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Body */}
        <div className="p-4">
          {/* Description */}
          <p className="text-sm text-zinc-400 mb-3">
            {isReply ? (
              <>Replying to: <span className="text-white font-medium">{replyTo?.subject}</span></>
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
            className="w-full h-40 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 resize-none focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
          />
          
          {/* Error message */}
          {error && (
            <p className="mt-2 text-sm text-red-400">{error}</p>
          )}
        </div>
        
        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-700 bg-zinc-800/50 rounded-b-lg">
          <span className="text-xs text-zinc-500">
            Press <kbd className="px-1.5 py-0.5 bg-zinc-700 rounded text-zinc-300">Cmd</kbd>+<kbd className="px-1.5 py-0.5 bg-zinc-700 rounded text-zinc-300">Enter</kbd> to send
          </span>
          
          <button
            onClick={handleSubmit}
            disabled={isSending || !message.trim() || (mode === 'arm' && !selectedArmId)}
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
    </div>,
    document.body
  );
}
