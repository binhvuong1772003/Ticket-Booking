import { Injectable } from '@nestjs/common';

type UserContact = {
  id: string;
  email: string;
  fullName: string | null;
};

// Tra userId → email qua query nội bộ userContact của auth-service
// (GraphQL). Lỗi ném ra để BullMQ retry job email.
@Injectable()
export class AuthClient {
  private readonly baseUrl =
    process.env.AUTH_SERVICE_URL ?? 'http://localhost:4001/graphql';

  async getUserContact(userId: string): Promise<UserContact> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query ($id: String!) {
          userContact(id: $id) { id email fullName }
        }`,
        variables: { id: userId },
      }),
    });
    if (!response.ok) {
      throw new Error(`auth-service responded ${response.status}`);
    }
    const body = (await response.json()) as {
      data?: { userContact?: UserContact };
      errors?: unknown[];
    };
    if (body.errors?.length || !body.data?.userContact) {
      throw new Error(`userContact ${userId} lookup failed`);
    }
    return body.data.userContact;
  }
}
