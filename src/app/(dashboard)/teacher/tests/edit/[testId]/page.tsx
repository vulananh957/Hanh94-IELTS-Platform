import { EditTestPage } from '../../../../../../features/upload-test/components/edit-test-page';
import '../../../upload/upload-placeholder.css';

export default async function EditTestRoute({ params }: { params: Promise<{ testId: string }> }) {
  const { testId } = await params;
  return (
    <div className="edit-test-canvas">
      <EditTestPage testId={testId} />
    </div>
  );
}
