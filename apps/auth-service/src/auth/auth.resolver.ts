import { Query, Resolver, Mutation, Args } from '@nestjs/graphql';
import { AuthService } from './services/auth.service';
import { AuthTokensPayload } from './dto/auth-tokens.payload';
import { RegisterInput } from './dto/register.input';
import { LoginInput } from './dto/login.input';
@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}
  @Query(() => String)
  health(): string {
    return 'auth-service is healthy';
  }
  @Mutation(() => AuthTokensPayload)
  async register(
    @Args('input', { type: () => RegisterInput }) input: RegisterInput,
  ) {
    return this.authService.register(input);
  }
  @Mutation(() => AuthTokensPayload)
  async login(@Args('input', { type: () => LoginInput }) input: LoginInput) {
    return this.authService.login(input);
  }
  @Mutation(() => Boolean)
  async logout(
    @Args('refreshToken', { type: () => String }) refreshToken: string,
  ) {
    await this.authService.logout(refreshToken);
    return true;
  }
}
