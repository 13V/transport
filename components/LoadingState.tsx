'use client';

import { motion } from 'framer-motion';

export default function LoadingState() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="space-y-6 text-center">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
          className="text-6xl inline-block"
        >
          🔍
        </motion.div>
        <div className="space-y-2">
          <p className="text-xl font-semibold">Analyzing token...</p>
          <p className="text-gray-400">Fetching on-chain data from Helius</p>
        </div>
        <div className="flex gap-1 justify-center">
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ duration: 1, delay: i * 0.2, repeat: Infinity }}
              className="w-2 h-2 bg-blue-500 rounded-full"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
