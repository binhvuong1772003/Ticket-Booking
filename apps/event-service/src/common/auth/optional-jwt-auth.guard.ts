import { ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';

@Injectable()
export class OptionalJwtAuthGuard extends JwtAuthGuard {
  constructor(jwtService: JwtService) {
    super(jwtService);
  }

  override canActivate(context: ExecutionContext) {
    try {
      super.canActivate(context);
    } catch {
      // anonymous — req.user stays undefined
    }
    return true;
  }
}
