import { Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import { CreateCategoryInput } from '../presentation/graphql/inputs/create-category.input';
import { UpdateCategoryInput } from '../presentation/graphql/inputs/update-category.input';
import { CategoryRepository } from '../infrastructure/category.repository';

@Injectable()
export class CategoryService {
  constructor(private readonly categories: CategoryRepository) {}

  findAll() {
    return this.categories.findAll();
  }

  findActive() {
    return this.categories.findActive();
  }

  async findById(id: string) {
    if (!/^[0-9a-f]{24}$/i.test(id)) {
      throw new ApiError('Category not found', 'NOT_FOUND');
    }
    const category = await this.categories.findById(id);
    if (!category) {
      throw new ApiError('Category not found', 'NOT_FOUND');
    }
    return category;
  }

  create(input: CreateCategoryInput) {
    const name = input.name.trim();
    const slug = input.slug.trim().toLowerCase();
    if (!name || !slug) {
      throw new ApiError(
        'Category name and slug are required',
        'BAD_USER_INPUT',
      );
    }
    return this.categories.create({
      name,
      slug,
      isActive: input.isActive ?? true,
    });
  }

  update(input: UpdateCategoryInput) {
    const data = {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.slug !== undefined && {
        slug: input.slug.trim().toLowerCase(),
      }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    };
    if (!Object.keys(data).length) {
      throw new ApiError(
        'At least one field must be updated',
        'BAD_USER_INPUT',
      );
    }
    if (('name' in data && !data.name) || ('slug' in data && !data.slug)) {
      throw new ApiError(
        'Category name and slug cannot be empty',
        'BAD_USER_INPUT',
      );
    }
    return this.categories.update(input.id, data);
  }

  remove(id: string) {
    if (!/^[0-9a-f]{24}$/i.test(id)) {
      throw new ApiError('Category not found', 'NOT_FOUND');
    }
    return this.categories.remove(id);
  }
}
