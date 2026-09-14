import type { NativeChatMessage } from './chat-transport';
import { formatTime } from './time';

export default function MessageBubble({ message }: { message: NativeChatMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-avatar" aria-hidden="true">
        {message.role === 'assistant' ? 'R' : 'You'}
      </div>
      <div>
        <header>
          <strong>{message.role === 'assistant' ? 'Randolph' : 'You'}</strong>
          {message.metadata?.createdAt ? <time dateTime={message.metadata.createdAt}>{formatTime(message.metadata.createdAt)}</time> : null}
        </header>
        {message.parts.map((part, index) => part.type === 'text' ? <p key={index}>{part.text}</p> : null)}
      </div>
    </article>
  );
}
