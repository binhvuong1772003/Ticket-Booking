import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AdminGuard } from '../../../../common/auth/admin.guard';
import { CategoryService } from '../../application/category.service';
import { CreateCategoryInput } from './inputs/create-category.input';
import { UpdateCategoryInput } from './inputs/update-category.input';
import { CategoryModel } from './models/category.model';

@UseGuards(AdminGuard)
@Resolver(() => CategoryModel)
export class CategoriesResolver {
  constructor(private readonly categoryService: CategoryService) {}

  @Query(() => [CategoryModel])
  adminCategories() {
    return this.categoryService.findAll();
  }

  @Query(() => CategoryModel)
  adminCategory(@Args('id', { type: () => ID }) id: string) {
    return this.categoryService.findById(id);
  }

  @Mutation(() => CategoryModel)
  createCategory(@Args('input') input: CreateCategoryInput) {
    return this.categoryService.create(input);
  }

  @Mutation(() => CategoryModel)
  updateCategory(@Args('input') input: UpdateCategoryInput) {
    return this.categoryService.update(input);
  }

  @Mutation(() => Boolean)
  deleteCategory(@Args('id', { type: () => ID }) id: string) {
    return this.categoryService.remove(id);
  }
}
