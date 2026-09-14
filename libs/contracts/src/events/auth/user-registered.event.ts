export type UserRegisteredEvent = {
  eventId: string;
  eventType: 'auth.user.registered';
  occurredAt: string;
  payload: {
    userId: string;
    email: string;
    createdAt: string;
  };
};
