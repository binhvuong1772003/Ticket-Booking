import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ApiError } from '../../../common/errors/api-error';

export type CreateCategoryData = {
  name: string;
  slug: string;
  isActive?: boolean;
};

export type UpdateCategoryData = {
  name?: string;
  slug?: string;
  isActive?: boolean;
};

@Injectable()
export class CategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.category.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  findActive() {
    return this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  findById(id: string) {
    return this.prisma.category.findUnique({ where: { id } });
  }

  async create(data: CreateCategoryData) {
    try {
      return await this.prisma.category.create({ data });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ApiError('Category slug already exists', 'CONFLICT', {
          field: 'slug',
        });
      }
      throw error;
    }
  }

  async update(id: string, data: UpdateCategoryData) {
    try {
      return await this.prisma.category.update({ where: { id }, data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new ApiError('Category slug already exists', 'CONFLICT', {
            field: 'slug',
          });
        }
        if (error.code === 'P2025') {
          throw new ApiError('Category not found', 'NOT_FOUND');
        }
      }
      throw error;
    }
  }

  async remove(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!category) {
      throw new ApiError('Category not found', 'NOT_FOUND');
    }

    const eventCount = await this.prisma.event.count({
      where: { categoryId: id },
    });
    if (eventCount > 0) {
      throw new ApiError('Category is assigned to events', 'CONFLICT', {
        eventCount,
      });
    }

    try {
      await this.prisma.category.delete({ where: { id } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025') {
          throw new ApiError('Category not found', 'NOT_FOUND');
        }
        if (error.code === 'P2003' || error.code === 'P2014') {
          throw new ApiError('Category is assigned to events', 'CONFLICT');
        }
      }
      throw error;
    }
  }
}
