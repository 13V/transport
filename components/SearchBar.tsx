'use client';

import { useState } from 'react';
import { Search } from 'lucide-react';

interface SearchBarProps {
  onSearch: (mint: string) => void;
  loading?: boolean;
}

export default function SearchBar({ onSearch, loading = false }: SearchBarProps) {
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(input.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="relative">
        <input
          type="text"
          placeholder="Enter token mint address (e.g., EPjFWaJy47gwhAj6CzjwucEgCwqPEfequpZiSymphony1111)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
          className="input w-full pl-12 pr-4 py-3 text-base"
        />
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" />
      </div>

      <button
        type="submit"
        disabled={loading || !input.trim()}
        className="btn btn-primary w-full"
      >
        {loading ? (
          <>
            <span className="inline-block animate-spin mr-2">⏳</span>
            Analyzing...
          </>
        ) : (
          'Analyze Token'
        )}
      </button>
    </form>
  );
}
