import { Query, Resolver } from '@nestjs/graphql';
import { CategoryService } from '../../application/category.service';
import { CategoryModel } from './models/category.model';

@Resolver(() => CategoryModel)
export class PublicCategoriesResolver {
  constructor(private readonly categoryService: CategoryService) {}

  @Query(() => [CategoryModel])
  publicCategories() {
    return this.categoryService.findActive();
  }
}
